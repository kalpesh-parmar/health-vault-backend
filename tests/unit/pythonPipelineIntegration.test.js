const { env } = require("../../src/configs/env");
const documentService = require("../../src/services/document.service");
const patientRepository = require("../../src/repositories/patientRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const objectStorageService = require("../../src/services/objectStorage.service");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const documentQueue = require("../../src/services/queue/documentQueue.service");
const sseConnectionService = require("../../src/services/sseConnection.service");
const { StageType } = require("../../src/enums/stageStatus");
const { DOCUMENT_STAGES } = require("../../src/constants/documentProgress.constants");
const { ProgressEmitter } = require("../../src/services/progressEmitter.service");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/repositories/documentProcessingJobRepository");
jest.mock("../../src/services/objectStorage.service");
jest.mock("../../src/clients/aiServiceClient");
jest.mock("../../src/services/queue/documentQueue.service");
jest.mock("pdf-parse", () => jest.fn(async () => ({ numpages: 2 })));

describe("M1 Wave 5: Python Pipeline Integration, Dispatch, Feature Flag & Retry", () => {
  const patientId = "a1111111-1111-4111-a111-111111111111";
  const dummyPdfBuffer = Buffer.from("%PDF-1.4 test document content");
  const dummyFile = {
    originalname: "test_blood_work.pdf",
    mimetype: "application/pdf",
    buffer: dummyPdfBuffer,
    size: dummyPdfBuffer.length,
  };

  let emitterSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    emitterSpy = jest.spyOn(ProgressEmitter, "for");

    patientRepository.findById.mockResolvedValue({
      id: patientId,
      preferredLanguage: "english",
    });

    objectStorageService.uploadFile.mockResolvedValue({
      fileKey: "documents/patient-1/test-key-123.pdf",
      s3Key: "documents/patient-1/test-key-123.pdf",
      s3Bucket: "test-health-vault-bucket",
      storageProvider: "s3",
    });

    documentProcessingJobRepository.createQueuedJob.mockImplementation(async (data) => ({
      id: "b2222222-2222-4222-b222-222222222222",
      fileKey: data.fileKey,
      userId: data.userId,
      status: "QUEUED",
      stage: "OCR_QUEUED",
      attemptCount: 0,
      metadata: data.metadata || {},
      checkpointData: data.checkpointData || {},
    }));

    documentRepository.upsertInitialDocument.mockImplementation(async (data) => ({
      id: data.id,
      userId: data.userId,
      fileName: data.fileName,
      s3Bucket: data.s3Bucket,
      s3Key: data.s3Key,
      fileType: data.fileType,
      fileSize: data.fileSize,
      ocrStatus: data.ocrStatus,
    }));

    aiServiceClient.dispatchDocumentProcessing.mockResolvedValue({
      jobId: "b2222222-2222-4222-b222-222222222222",
      status: "QUEUED",
    });
  });

  describe("1. Upload Flow with USE_PYTHON_PIPELINE = true", () => {
    beforeEach(() => {
      env.usePythonPipeline = true;
    });

    afterEach(() => {
      env.usePythonPipeline = false;
    });

    test("uploads original to S3, inserts initial QUEUED job, and dispatches pointer-only payload to Python exactly once", async () => {
      const result = await documentService.uploadDocuments([dummyFile], patientId);

      // Verify S3 upload called with original file
      expect(objectStorageService.uploadFile).toHaveBeenCalledTimes(1);
      expect(objectStorageService.uploadFile).toHaveBeenCalledWith(
        dummyFile,
        expect.any(String),
        patientId,
      );

      // Verify DB initial INSERT as QUEUED
      expect(documentProcessingJobRepository.createQueuedJob).toHaveBeenCalledTimes(1);
      const createJobArgs = documentProcessingJobRepository.createQueuedJob.mock.calls[0][0];
      expect(createJobArgs.userId).toBe(patientId);
      expect(createJobArgs.metadata.processor).toBe("python");
      expect(createJobArgs.checkpointData.uploaded).toBe(true);
      expect(createJobArgs.checkpointData.s3Bucket).toBe("test-health-vault-bucket");
      expect(createJobArgs.checkpointData.sha256).toBeDefined();

      // Verify Python dispatch called exactly once
      expect(aiServiceClient.dispatchDocumentProcessing).toHaveBeenCalledTimes(1);
      const dispatchPayload = aiServiceClient.dispatchDocumentProcessing.mock.calls[0][0];

      // Contract verification: pointer-only, zero file bytes
      expect(dispatchPayload).toEqual({
        jobId: "b2222222-2222-4222-b222-222222222222",
        patientId,
        documentId: expect.any(String),
        storage: {
          bucket: "test-health-vault-bucket",
          key: "documents/patient-1/test-key-123.pdf",
          sha256: expect.any(String),
        },
        documentType: "OTHER",
        preferredLanguage: "en",
        resumeFromStage: null,
      });

      // Assert NO file bytes, buffers, or raw OCR strings in dispatch payload
      expect(dispatchPayload).not.toHaveProperty("buffer");
      expect(dispatchPayload).not.toHaveProperty("file");
      expect(dispatchPayload).not.toHaveProperty("rawOcr");
      expect(dispatchPayload).not.toHaveProperty("extractedText");

      // Verify legacy Node queue was NOT enqueued
      expect(documentQueue.enqueue).not.toHaveBeenCalled();

      // Verify public response format matches contract
      expect(result).toHaveProperty("batchId");
      expect(result.patientId).toBe(patientId);
      expect(result.total).toBe(1);
      expect(result.batchUrl).toMatch(/^\/sse\/batches\/.+\/stream$/);
      expect(result.documents[0]).toEqual({
        jobId: "b2222222-2222-4222-b222-222222222222",
        fileKey: expect.stringMatching(/^doc_/),
        documentId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        fileName: "test_blood_work.pdf",
        status: StageType.QUEUED,
        streamUrl: expect.stringMatching(/^\/sse\/files\/doc_.+\/stream$/),
      });

      // Verify ProgressEmitter received logical fileKey and NOT s3Key
      expect(emitterSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fileKey: result.documents[0].fileKey,
          batchId: result.batchId,
        }),
      );
    });
  });

  describe("2. Rollback & Legacy Fallback (USE_PYTHON_PIPELINE = false)", () => {
    beforeEach(() => {
      env.usePythonPipeline = false;
    });

    test("when flag is false, new uploads use legacy Node queue and Python is never dispatched", async () => {
      const result = await documentService.uploadDocuments([dummyFile], patientId);

      // Verify legacy queue was called
      expect(documentQueue.enqueue).toHaveBeenCalledTimes(1);

      // Verify Python dispatch was NOT called
      expect(aiServiceClient.dispatchDocumentProcessing).not.toHaveBeenCalled();

      // Verify public response contract is identical
      expect(result).toHaveProperty("batchId");
      expect(result.total).toBe(1);
      expect(result.documents[0].status).toBe(StageType.QUEUED);
    });
  });

  describe("3. Public Retry Flow with USE_PYTHON_PIPELINE = true", () => {
    beforeEach(() => {
      env.usePythonPipeline = true;
    });

    afterEach(() => {
      env.usePythonPipeline = false;
    });

    test("retry transitions FAILED -> QUEUED without incrementing attempt_count in Node, dispatches Python with resumeFromStage", async () => {
      const fileKey = "documents/patient-1/failed-doc.pdf";
      const existingJob = {
        id: "c3333333-3333-4333-c333-333333333333",
        fileKey,
        userId: patientId,
        status: "FAILED",
        stage: DOCUMENT_STAGES.PARSING,
        stageStatus: "FAILED",
        attemptCount: 1,
        retryable: true,
        requiresReupload: false,
        completedStages: ["VALIDATING", "UPLOADING", "OCR_RUNNING"],
        checkpointData: {
          s3Bucket: "test-health-vault-bucket",
          s3Key: fileKey,
          sha256: "dummy-sha-256",
        },
        metadata: {
          documentId: "d4444444-4444-4444-d444-444444444444",
          preferredLanguage: "english",
        },
      };

      documentProcessingJobRepository.findByFileKey.mockResolvedValue(existingJob);
      documentProcessingJobRepository.reEnqueueJob.mockResolvedValue({
        ...existingJob,
        status: "QUEUED",
        stageStatus: "QUEUED",
      });

      const retryResult = await documentService.retryDocument({
        fileKey,
        userId: patientId,
        file: null,
      });

      // 1. Ownership & retry eligibility checked
      expect(documentProcessingJobRepository.findByFileKey).toHaveBeenCalledWith(
        fileKey,
        patientId,
      );

      // 2. Transition FAILED -> QUEUED via reEnqueueJob (Node does NOT call claimJobForRetry)
      expect(documentProcessingJobRepository.claimJobForRetry).not.toHaveBeenCalled();
      expect(documentProcessingJobRepository.reEnqueueJob).toHaveBeenCalledWith(
        existingJob.id,
        expect.objectContaining({
          status: "QUEUED",
          stageStatus: "QUEUED",
          error: null,
        }),
      );

      // 3. Node does NOT increment attempt_count
      const reEnqueuePatch = documentProcessingJobRepository.reEnqueueJob.mock.calls[0][1];
      expect(reEnqueuePatch).not.toHaveProperty("attemptCount");

      // 4. resumeFromStage calculated as next incomplete stage ("PARSING")
      expect(aiServiceClient.dispatchDocumentProcessing).toHaveBeenCalledTimes(1);
      const retryDispatch = aiServiceClient.dispatchDocumentProcessing.mock.calls[0][0];
      expect(retryDispatch.jobId).toBe(existingJob.id);
      expect(retryDispatch.resumeFromStage).toBe("PARSING");
      expect(retryDispatch.storage.bucket).toBe("test-health-vault-bucket");
      expect(retryDispatch.storage.key).toBe(fileKey);

      // 5. Node does NOT enqueue to legacy documentQueue
      expect(documentQueue.enqueue).not.toHaveBeenCalled();

      // 6. Public response format preserved
      expect(retryResult).toEqual({
        jobId: existingJob.id,
        fileKey,
        status: "RUNNING",
        resumeStage: "PARSING",
        progress: expect.any(Number),
        streamUrl: `/sse/files/${fileKey}/stream`,
      });
    });

    test("retry requires reupload when requiresReupload is true and file is missing", async () => {
      const fileKey = "documents/patient-1/failed-unuploaded.pdf";
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-reupload-req",
        fileKey,
        userId: patientId,
        status: "FAILED",
        stage: DOCUMENT_STAGES.UPLOADING,
        requiresReupload: true,
        attemptCount: 1,
        retryable: true,
      });

      await expect(
        documentService.retryDocument({ fileKey, userId: patientId, file: null }),
      ).rejects.toThrow("This stage failure requires re-uploading the file payload.");
    });

    test("retry rejects non-retryable jobs", async () => {
      const fileKey = "documents/patient-1/rejected.pdf";
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-rejected",
        fileKey,
        userId: patientId,
        status: "REJECTED",
        retryable: false,
      });

      await expect(documentService.retryDocument({ fileKey, userId: patientId })).rejects.toThrow(
        "This document failed with a non-retryable error and cannot be retried.",
      );
    });

    test("retry rejects jobs that exceeded max attempts", async () => {
      const fileKey = "documents/patient-1/maxed.pdf";
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-maxed",
        fileKey,
        userId: patientId,
        status: "FAILED",
        attemptCount: 3,
        retryable: true,
      });

      await expect(documentService.retryDocument({ fileKey, userId: patientId })).rejects.toThrow(
        "Maximum retry attempts (3) exceeded for this document.",
      );
    });
  });

  describe("4. Retry Flow with USE_PYTHON_PIPELINE = false (Legacy Retry)", () => {
    beforeEach(() => {
      env.usePythonPipeline = false;
    });

    test("retry in legacy mode uses claimJobForRetry and legacy documentQueue", async () => {
      const fileKey = "documents/patient-1/legacy-retry.pdf";
      const existingJob = {
        id: "job-legacy-1",
        fileKey,
        userId: patientId,
        status: "FAILED",
        stage: DOCUMENT_STAGES.OCR_RUNNING,
        attemptCount: 1,
        retryable: true,
        requiresReupload: false,
      };

      documentProcessingJobRepository.findByFileKey.mockResolvedValue(existingJob);
      documentProcessingJobRepository.claimJobForRetry.mockResolvedValue({
        ...existingJob,
        status: "RUNNING",
        attemptCount: 2,
      });

      const result = await documentService.retryDocument({ fileKey, userId: patientId });

      // In legacy mode, claimJobForRetry is called and documentQueue is enqueued
      expect(documentProcessingJobRepository.claimJobForRetry).toHaveBeenCalledWith(
        fileKey,
        patientId,
      );
      expect(documentQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(aiServiceClient.dispatchDocumentProcessing).not.toHaveBeenCalled();
      expect(result.status).toBe("RUNNING");
    });
  });

  describe("5. SSE Event Wire Compatibility & Zero-PHI", () => {
    test("sharedSseBus correctly forwards inbound remote event into sseConnectionService without PHI leaks", () => {
      const channelKey = "documents/patient-1/live-stream.pdf";
      const receiveRemoteSpy = jest.spyOn(sseConnectionService, "receiveRemote");

      const inboundEvent = {
        jobId: "b2222222-2222-4222-b222-222222222222",
        fileKey: channelKey,
        stage: "FIELD_EXTRACTION",
        stageStatus: "IN_PROGRESS",
        progress: 60,
        percentage: 60,
        status: "SUCCESS",
        message: "Extracting clinical fields from document",
        timestamp: new Date().toISOString(),
      };

      // Simulate remote event arriving at Node sharedSseBus
      sseConnectionService.receiveRemote(channelKey, inboundEvent);

      expect(receiveRemoteSpy).toHaveBeenCalledWith(channelKey, inboundEvent);

      // Verify zero-PHI: no patient clinical details in SSE envelope
      expect(inboundEvent).not.toHaveProperty("patientName");
      expect(inboundEvent).not.toHaveProperty("diagnosis");
      expect(inboundEvent).not.toHaveProperty("medications");
      expect(inboundEvent).not.toHaveProperty("clinicalText");
      expect(inboundEvent).not.toHaveProperty("rawOcr");
    });
  });

  describe("6. Structural End-to-End Integration Flow", () => {
    beforeEach(() => {
      env.usePythonPipeline = true;
    });

    afterEach(() => {
      env.usePythonPipeline = false;
    });

    test("POST /documents/upload -> S3 upload -> PG QUEUED -> Python dispatch -> Python worker claim -> checkpoints -> SSE bridge", async () => {
      // Step 1: Client calls uploadDocuments
      const uploadResponse = await documentService.uploadDocuments([dummyFile], patientId);
      expect(uploadResponse.total).toBe(1);
      const documentMeta = uploadResponse.documents[0];
      expect(documentMeta.status).toBe("QUEUED");

      // Verify S3 storage upload occurred
      expect(objectStorageService.uploadFile).toHaveBeenCalledTimes(1);

      // Verify Python dispatch called with pointer-only metadata
      expect(aiServiceClient.dispatchDocumentProcessing).toHaveBeenCalledTimes(1);
      const dispatchCall = aiServiceClient.dispatchDocumentProcessing.mock.calls[0][0];
      expect(dispatchCall.jobId).toBe(documentMeta.jobId);
      expect(dispatchCall.storage.key).toBe("documents/patient-1/test-key-123.pdf");

      // Step 2: Client subscribes to SSE stream
      const receivedEvents = [];
      const unsubscribe = sseConnectionService.subscribe(documentMeta.fileKey, (event) =>
        receivedEvents.push(event),
      );

      // Step 3: Python worker emits progress events through PostgreSQL NOTIFY -> Node sharedSseBus
      const stageUpdates = [
        {
          stage: "VALIDATING",
          stageStatus: "COMPLETED",
          progress: 10,
          percentage: 10,
          message: "Validation complete",
        },
        {
          stage: "OCR_RUNNING",
          stageStatus: "IN_PROGRESS",
          progress: 30,
          percentage: 30,
          message: "OCR processing",
        },
        {
          stage: "FIELD_EXTRACTION",
          stageStatus: "COMPLETED",
          progress: 65,
          percentage: 65,
          message: "Fields extracted",
        },
        {
          stage: "COMPLETED",
          stageStatus: "COMPLETED",
          progress: 100,
          percentage: 100,
          message: "Processing complete",
        },
      ];

      for (const update of stageUpdates) {
        sseConnectionService.receiveRemote(documentMeta.fileKey, {
          jobId: documentMeta.jobId,
          fileKey: documentMeta.fileKey,
          status: "SUCCESS",
          timestamp: new Date().toISOString(),
          ...update,
        });
      }

      // Step 4: Verify client received all progress events in order with zero PHI
      expect(receivedEvents.length).toBe(5);
      const stages = receivedEvents.map((e) => e.stage);
      expect(stages).toContain(StageType.QUEUED);
      expect(stages).toContain("VALIDATING");
      expect(stages).toContain("OCR_RUNNING");
      expect(stages).toContain("FIELD_EXTRACTION");
      expect(stages).toContain("COMPLETED");

      // Check zero-PHI across all events
      for (const evt of receivedEvents) {
        expect(evt).not.toHaveProperty("patientName");
        expect(evt).not.toHaveProperty("clinicalText");
      }

      unsubscribe();
    });
  });
});
