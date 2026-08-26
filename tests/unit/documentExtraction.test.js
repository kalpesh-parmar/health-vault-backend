const { runExtraction, runWithConcurrency } = require("../../src/services/document.service");
const documentService = require("../../src/services/document.service");
const objectStorageService = require("../../src/services/objectStorage.service");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const { ocrOrchestrator, ocrService } = require("../../src/services/ai");
const documentPersistenceService = require("../../src/services/documentPersistence.service");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const { DOCUMENT_STAGES } = require("../../src/constants/documentProgress.constants");
const { StageType } = require("../../src/enums/stageStatus");

jest.mock("../../src/services/objectStorage.service");
jest.mock("../../src/clients/aiServiceClient");
jest.mock("../../src/services/ai", () => ({
  ocrOrchestrator: {
    runFromStorage: jest.fn(),
  },
  ocrService: {
    normalizeExtraction: jest.fn(),
    generateSummary: jest.fn(),
  },
  embeddingService: {
    embedAndPersist: jest.fn(),
  },
}));
jest.mock("../../src/services/documentPersistence.service");
jest.mock("../../src/services/ai/clients/aiClient.service", () => ({
  extractGraphs: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../src/repositories/documentProcessingJobRepository", () => ({
  createQueuedJob: jest.fn(),
  checkpointStage: jest.fn().mockResolvedValue({}),
  markCompleted: jest.fn().mockResolvedValue({}),
  findByFileKey: jest.fn().mockResolvedValue(null),
  claimJobForRetry: jest.fn(),
  findStalledRunningJobs: jest.fn().mockResolvedValue([]),
  reconcileRunningJobsOnBoot: jest.fn().mockResolvedValue([]),
}));

describe("runExtraction Unit Tests", () => {
  let dummyFile;
  let dummyRecord;
  let mockEmitter;

  beforeEach(() => {
    jest.clearAllMocks();

    dummyFile = {
      originalname: "blood_test_report.pdf",
      mimetype: "application/pdf",
      size: 1024 * 50,
      buffer: Buffer.from("dummy pdf data"),
    };

    dummyRecord = {
      jobId: "job-123",
      fileKey: "doc-key-123",
      batchId: "batch-456",
      patientId: "patient-789",
      uploadedBy: "patient-789",
      fileName: "blood_test_report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024 * 50,
      status: StageType.QUEUED,
    };

    mockEmitter = {
      stage: jest.fn(),
      error: jest.fn(),
      done: jest.fn(),
    };

    objectStorageService.uploadFile.mockResolvedValue({
      fileKey: "doc-key-123",
      s3Bucket: "health-vault-dev-bucket",
    });

    aiServiceClient.validateMedicalDocument.mockResolvedValue({
      isMedical: true,
      confidence: 0.95,
      documentType: "LAB_REPORT",
      reason: "Blood test report with lab values",
      method: "medgemma",
      model: "medgemma:4b",
      metrics: { processing_seconds: 0.5, pages_used: 1, used_ollama: true },
    });

    ocrOrchestrator.runFromStorage.mockResolvedValue({
      fullText: "Patient Name: John Doe\nHemoglobin: 14.2 g/dL",
      pageCount: 1,
    });

    ocrService.normalizeExtraction.mockResolvedValue({
      rawOcrData: { fullText: "Patient Name: John Doe\nHemoglobin: 14.2 g/dL" },
      structured: { summary: "Normal blood test report", reportType: "LAB_REPORT" },
    });

    documentPersistenceService.addDocument.mockResolvedValue({
      document: { id: "doc-uuid-999", fileName: "blood_test_report.pdf" },
      embeddings: { embeddings: 1 },
    });
  });

  test("Valid medical document completes full extraction pipeline successfully", async () => {
    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).not.toBeNull();
    expect(result.status).toBe(StageType.COMPLETED);
    expect(objectStorageService.uploadFile).toHaveBeenCalledWith(
      dummyFile,
      "documents",
      "patient-789",
      { fileKey: "doc-key-123" },
    );
    expect(aiServiceClient.validateMedicalDocument).toHaveBeenCalledWith({
      file: dummyFile.buffer,
      fileName: dummyFile.originalname,
      mimeType: dummyFile.mimetype,
    });
    expect(ocrOrchestrator.runFromStorage).toHaveBeenCalled();
    expect(mockEmitter.done).toHaveBeenCalledTimes(1);
    expect(mockEmitter.error).not.toHaveBeenCalled();
  });

  test("Non-medical document fails validation as FATAL and marks REJECTED (non-retryable)", async () => {
    aiServiceClient.validateMedicalDocument.mockResolvedValue({
      isMedical: false,
      confidence: 0.2,
      reason: "Document appears to be a electricity bill",
      method: "medgemma",
      model: "medgemma:4b",
      metrics: { processing_seconds: 0.4, pages_used: 1, used_ollama: true },
    });

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(dummyRecord.status).toBe("REJECTED");
    expect(dummyRecord.retryable).toBe(false);
    expect(mockEmitter.error).toHaveBeenCalledWith(
      DOCUMENT_STAGES.VALIDATING,
      expect.any(Object),
      expect.objectContaining({
        retryable: false,
        requiresReupload: true,
        failedStage: DOCUMENT_STAGES.VALIDATING,
      }),
    );
    expect(ocrOrchestrator.runFromStorage).not.toHaveBeenCalled();
    expect(mockEmitter.done).not.toHaveBeenCalled();
  });

  test("Invalid MIME type fails early during format validation stage as FATAL non-retryable", async () => {
    dummyRecord.mimeType = "application/x-executable";

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(dummyRecord.status).toBe("REJECTED");
    expect(dummyRecord.errorCode).toBe("INVALID_DOCUMENT_TYPE");
    expect(dummyRecord.retryable).toBe(false);
    expect(mockEmitter.error).toHaveBeenCalledWith(
      DOCUMENT_STAGES.VALIDATING,
      expect.any(Object),
      expect.objectContaining({
        retryable: false,
        errorCode: "INVALID_DOCUMENT_TYPE",
      }),
    );
    expect(objectStorageService.uploadFile).not.toHaveBeenCalled();
    expect(aiServiceClient.validateMedicalDocument).not.toHaveBeenCalled();
  });

  test("Step 1 Regression: OCR engine failure reports the ACTUAL failing stage (OCR_RUNNING)", async () => {
    ocrOrchestrator.runFromStorage.mockRejectedValue(
      new Error("OCR engine crash: unreadable stream"),
    );

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(dummyRecord.status).toBe(StageType.FAILED);
    expect(dummyRecord.failedStage).toBe(DOCUMENT_STAGES.OCR_RUNNING);
    expect(mockEmitter.error).toHaveBeenCalledWith(
      DOCUMENT_STAGES.OCR_RUNNING,
      expect.any(Object),
      expect.objectContaining({
        failedStage: DOCUMENT_STAGES.OCR_RUNNING,
        retryable: true,
      }),
    );
    expect(mockEmitter.done).not.toHaveBeenCalled();
  });

  test("Transient failure at FIELD_EXTRACTION emits retryable error with requiresReupload=false", async () => {
    ocrService.normalizeExtraction.mockRejectedValue(new Error("AI microservice 503 unavailable"));

    const result = await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(result).toBeNull();
    expect(dummyRecord.status).toBe(StageType.FAILED);
    expect(dummyRecord.failedStage).toBe(DOCUMENT_STAGES.FIELD_EXTRACTION);
    expect(dummyRecord.retryable).toBe(true);
    expect(dummyRecord.requiresReupload).toBe(false);
    expect(mockEmitter.error).toHaveBeenCalledWith(
      DOCUMENT_STAGES.FIELD_EXTRACTION,
      expect.any(Object),
      expect.objectContaining({
        failedStage: DOCUMENT_STAGES.FIELD_EXTRACTION,
        retryable: true,
        requiresReupload: false,
      }),
    );
  });

  test("Resuming from FIELD_EXTRACTION skips VALIDATING, UPLOADING, and OCR_RUNNING stages", async () => {
    const existingJob = {
      id: "job-123",
      fileKey: "doc-key-123",
      userId: "patient-789",
      status: "FAILED",
      stage: DOCUMENT_STAGES.FIELD_EXTRACTION,
      attemptCount: 1,
      completedStages: [
        DOCUMENT_STAGES.VALIDATING,
        DOCUMENT_STAGES.UPLOADING,
        DOCUMENT_STAGES.OCR_RUNNING,
        DOCUMENT_STAGES.PARSING,
      ],
      rawOcrData: { fullText: "Previously extracted OCR text" },
      checkpointData: {
        validation: { isMedical: true },
        uploaded: true,
        s3Bucket: "health-vault-dev-bucket",
      },
    };

    const result = await runExtraction({
      file: { originalname: "blood_test_report.pdf", mimetype: "application/pdf" },
      record: dummyRecord,
      emitter: mockEmitter,
      job: existingJob,
    });

    expect(result).not.toBeNull();
    expect(result.status).toBe(StageType.COMPLETED);
    // Assert earlier stages were NOT re-executed
    expect(aiServiceClient.validateMedicalDocument).not.toHaveBeenCalled();
    expect(objectStorageService.uploadFile).not.toHaveBeenCalled();
    expect(ocrOrchestrator.runFromStorage).not.toHaveBeenCalled();
    // Assert field extraction resumed from checkpointed OCR text
    expect(ocrService.normalizeExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        rawOcr: { fullText: "Previously extracted OCR text" },
      }),
    );
    expect(mockEmitter.done).toHaveBeenCalledTimes(1);
  });

  test("Retry endpoint Mode A rejects when stage requires re-upload but no file is provided", async () => {
    documentProcessingJobRepository.findByFileKey.mockResolvedValue({
      id: "job-123",
      fileKey: "doc-key-123",
      userId: "patient-789",
      status: "FAILED",
      stage: DOCUMENT_STAGES.VALIDATING,
      requiresReupload: true,
      attemptCount: 1,
      retryable: true,
    });

    await expect(
      documentService.retryDocument({
        fileKey: "doc-key-123",
        userId: "patient-789",
        file: null,
      }),
    ).rejects.toThrow("This stage failure requires re-uploading the file payload.");
  });

  test("Retry endpoint refuses retry when job is REJECTED", async () => {
    documentProcessingJobRepository.findByFileKey.mockResolvedValue({
      id: "job-123",
      fileKey: "doc-key-123",
      userId: "patient-789",
      status: "REJECTED",
      stage: DOCUMENT_STAGES.VALIDATING,
      retryable: false,
    });

    await expect(
      documentService.retryDocument({
        fileKey: "doc-key-123",
        userId: "patient-789",
      }),
    ).rejects.toThrow("This document failed with a non-retryable error and cannot be retried.");
  });

  test("Retry endpoint refuses retry when attemptCount reaches maximum limit", async () => {
    documentProcessingJobRepository.findByFileKey.mockResolvedValue({
      id: "job-123",
      fileKey: "doc-key-123",
      userId: "patient-789",
      status: "FAILED",
      stage: DOCUMENT_STAGES.OCR_RUNNING,
      attemptCount: 3,
      retryable: true,
    });

    await expect(
      documentService.retryDocument({
        fileKey: "doc-key-123",
        userId: "patient-789",
      }),
    ).rejects.toThrow("Maximum retry attempts (3) exceeded for this document.");
  });

  test("Single completion event (done or error) is emitted per document without duplicate done calls", async () => {
    await runExtraction({
      file: dummyFile,
      record: dummyRecord,
      emitter: mockEmitter,
    });

    expect(mockEmitter.done).toHaveBeenCalledTimes(1);
    expect(mockEmitter.error).not.toHaveBeenCalled();
  });

  test("Concurrency runner processes multiple document jobs boundedly", async () => {
    const jobs = [
      { file: dummyFile, record: { ...dummyRecord, fileKey: "k1" }, emitter: mockEmitter },
      { file: dummyFile, record: { ...dummyRecord, fileKey: "k2" }, emitter: mockEmitter },
    ];

    await runWithConcurrency(jobs, 2);

    expect(objectStorageService.uploadFile).toHaveBeenCalledTimes(2);
    expect(aiServiceClient.validateMedicalDocument).toHaveBeenCalledTimes(2);
  });
});
