const { EventEmitter } = require("events");
const documentQueue = require("../../src/services/queue/documentQueue.service");
const sharedSseBus = require("../../src/services/sse/sharedSseBus");
const sseConnection = require("../../src/services/sseConnection.service");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const sseController = require("../../src/controllers/sse.controller");
const { pool } = require("../../src/configs/db");
const { StageType, ProcessStatus } = require("../../src/enums/stageStatus");
const { DOCUMENT_STAGES } = require("../../src/constants/documentProgress.constants");

jest.mock("../../src/repositories/documentProcessingJobRepository");

describe("Phase 2: Durable Queue & Shared SSE Bus Unit Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    documentQueue.clear();
    documentQueue.resume();
    documentQueue.heartbeatIntervalMs = 15000;
    sseConnection.destroy();
    sharedSseBus.isDestroyed = false;
  });

  afterEach(async () => {
    documentQueue.clear();
    documentQueue.pause();
    documentQueue.heartbeatIntervalMs = 15000;
    sseConnection.destroy();
    await sharedSseBus.close();
  });

  afterAll(async () => {
    documentQueue.clear();
    documentQueue.pause();
    sseConnection.destroy();
    await sharedSseBus.close();
  });

  describe("1. Queue Worker Concurrency & Execution", () => {
    it("should respect bounded concurrency limit and not exceed max simultaneous workers", async () => {
      let activeCount = 0;
      let maxSeenActive = 0;
      const totalJobs = 10;
      const concurrencyLimit = 3;

      documentQueue.concurrency = concurrencyLimit;

      const mockRunner = jest.fn().mockImplementation(async () => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCount--;
      });

      documentQueue.setRunner(mockRunner);

      for (let i = 0; i < totalJobs; i++) {
        documentQueue.enqueue({
          file: { originalname: `doc_${i}.pdf` },
          record: { fileKey: `key_${i}`, jobId: `job_${i}` },
          emitter: { stage: jest.fn() },
          job: { id: `job_${i}` },
        });
      }

      // Wait for all jobs to complete
      const start = Date.now();
      while (
        (mockRunner.mock.calls.length < totalJobs || documentQueue.activeWorkers > 0) &&
        Date.now() - start < 3000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(mockRunner).toHaveBeenCalledTimes(totalJobs);
      expect(maxSeenActive).toBeLessThanOrEqual(concurrencyLimit);
      expect(documentQueue.activeWorkers).toBe(0);
    });

    it("should start and stop heartbeat timer during job execution", async () => {
      documentQueue.heartbeatIntervalMs = 20; // short interval for test

      documentProcessingJobRepository.updateHeartbeat.mockResolvedValue({});

      const mockRunner = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });

      documentQueue.setRunner(mockRunner);

      documentQueue.enqueue({
        file: { originalname: "doc_hb.pdf" },
        record: { fileKey: "key_hb", jobId: "job_hb_123" },
        emitter: { stage: jest.fn() },
        job: { id: "job_hb_123" },
      });

      // Wait for runner to finish
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(mockRunner).toHaveBeenCalled();
      expect(documentProcessingJobRepository.updateHeartbeat).toHaveBeenCalledWith("job_hb_123");
      const callsAfterJob = documentProcessingJobRepository.updateHeartbeat.mock.calls.length;
      expect(callsAfterJob).toBeGreaterThanOrEqual(1);

      // Wait additional intervals to verify heartbeat timer stopped and does not continue ticking
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(documentProcessingJobRepository.updateHeartbeat.mock.calls.length).toBe(callsAfterJob);
    });
  });

  describe("2. Boot Crash Recovery & Resumption (resumeOrphanedJobsOnBoot)", () => {
    it("should automatically re-enqueue orphaned uploaded jobs to resume from checkpoint", async () => {
      const orphanedJobs = [
        {
          id: "job-uploaded-1",
          fileKey: "doc-key-uploaded-1",
          userId: "user-123",
          status: "RUNNING",
          stage: DOCUMENT_STAGES.FIELD_EXTRACTION,
          checkpointData: { uploaded: true, s3Bucket: "my-bucket", s3Key: "doc-key-uploaded-1" },
          completedStages: [
            DOCUMENT_STAGES.VALIDATING,
            DOCUMENT_STAGES.UPLOADING,
            DOCUMENT_STAGES.OCR_RUNNING,
          ],
        },
      ];

      documentProcessingJobRepository.getOrphanedRunningJobs.mockResolvedValue(orphanedJobs);
      documentProcessingJobRepository.reEnqueueJob.mockResolvedValue({ id: "job-uploaded-1" });

      const recovered = await documentQueue.resumeOrphanedJobsOnBoot();

      expect(documentProcessingJobRepository.getOrphanedRunningJobs).toHaveBeenCalled();
      expect(documentProcessingJobRepository.reEnqueueJob).toHaveBeenCalledWith(
        "job-uploaded-1",
        expect.objectContaining({
          message: expect.stringContaining("Resuming execution"),
        }),
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0].resumed).toBe(true);
    });

    it("should mark orphaned un-uploaded jobs as FAILED with requiresReupload = true", async () => {
      const orphanedJobs = [
        {
          id: "job-failed-pre-upload",
          fileKey: "doc-key-pre-upload",
          userId: "user-123",
          status: "RUNNING",
          stage: DOCUMENT_STAGES.VALIDATING,
          checkpointData: { uploaded: false },
          completedStages: [],
        },
      ];

      documentProcessingJobRepository.getOrphanedRunningJobs.mockResolvedValue(orphanedJobs);
      documentProcessingJobRepository.checkpointStage.mockResolvedValue({});

      const recovered = await documentQueue.resumeOrphanedJobsOnBoot();

      expect(documentProcessingJobRepository.checkpointStage).toHaveBeenCalledWith(
        "job-failed-pre-upload",
        expect.objectContaining({
          status: "FAILED",
          stageStatus: StageType.FAILED,
          requiresReupload: true,
          retryable: true,
        }),
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0].resumed).toBe(false);
    });
  });

  describe("3. Shared SSE Bus Adapter (PostgreSQL LISTEN / NOTIFY)", () => {
    it("should publish outbound events via pg_notify query", async () => {
      const poolQuerySpy = jest.spyOn(pool, "query").mockResolvedValue({});

      const event = {
        fileKey: "file_test_99",
        stage: DOCUMENT_STAGES.OCR_RUNNING,
        percentage: 45,
        status: ProcessStatus.SUCCESS,
      };

      await sharedSseBus.publish("file_test_99", event);

      expect(poolQuerySpy).toHaveBeenCalledWith(
        "SELECT pg_notify($1, $2)",
        expect.arrayContaining(["health_vault_sse_events"]),
      );

      const payload = JSON.parse(poolQuerySpy.mock.calls[0][1][1]);
      expect(payload.channelKey).toBe("file_test_99");
      expect(payload.event.percentage).toBe(45);

      poolQuerySpy.mockRestore();
    });

    it("should truncate oversized payloads to stay safely under PostgreSQL 8000-byte limit", async () => {
      const poolQuerySpy = jest.spyOn(pool, "query").mockResolvedValue({});

      const largeEvent = {
        fileKey: "file_large_1",
        stage: DOCUMENT_STAGES.FIELD_EXTRACTION,
        percentage: 60,
        status: ProcessStatus.SUCCESS,
        hugeBlob: "x".repeat(10000), // 10KB string
      };

      await sharedSseBus.publish("file_large_1", largeEvent);

      expect(poolQuerySpy).toHaveBeenCalled();
      const payloadString = poolQuerySpy.mock.calls[0][1][1];
      expect(Buffer.byteLength(payloadString, "utf8")).toBeLessThanOrEqual(7500);

      const parsed = JSON.parse(payloadString);
      expect(parsed.event.truncated).toBe(true);
      expect(parsed.event.hugeBlob).toBeUndefined();

      poolQuerySpy.mockRestore();
    });

    it("should deliver remote events into local sseConnection without re-publishing outbound", () => {
      const remoteEventsReceived = [];

      sseConnection.subscribe("file_remote_101", (ev) => {
        remoteEventsReceived.push(ev);
      });

      const adapterPublishSpy = jest.fn();
      sseConnection.setAdapter({ publish: adapterPublishSpy });

      // Simulate remote event arriving from sharedSseBus
      sseConnection.receiveRemote("file_remote_101", {
        fileKey: "file_remote_101",
        stage: DOCUMENT_STAGES.PERSISTING,
        percentage: 80,
      });

      expect(remoteEventsReceived).toHaveLength(1);
      expect(remoteEventsReceived[0].percentage).toBe(80);
      // Because fromAdapter: true, adapter.publish must NOT be called again
      expect(adapterPublishSpy).not.toHaveBeenCalled();
    });
  });

  describe("4. Dynamic Channel Hydration in sse.controller.js", () => {
    it("should dynamically hydrate channel from database when not in memory", async () => {
      const fileKey = "file_unbuffered_001";
      const userId = "user_patient_999";

      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-db-001",
        fileKey,
        userId,
        status: "RUNNING",
        stage: DOCUMENT_STAGES.OCR_RUNNING,
        stageStatus: StageType.IN_PROGRESS,
        percentage: 35,
        metadata: { originalName: "blood_report.pdf", batchId: "batch-101" },
        updatedAt: new Date(),
      });

      const req = new EventEmitter();
      req.params = { fileKey };
      req.auth = { userId };
      req.get = jest.fn().mockReturnValue(null);
      req.query = {};

      const res = new EventEmitter();
      res.statusCode = 200;
      res.status = jest.fn().mockReturnValue(res);
      res.setHeader = jest.fn();
      res.flushHeaders = jest.fn();
      res.write = jest.fn();
      res.end = jest.fn();

      // Ensure channel is absent from memory initially
      expect(sseConnection.channels.has(fileKey)).toBe(false);

      await sseController.streamFile(req, res);

      // Now channel should be dynamically created in sseConnection
      expect(sseConnection.channels.has(fileKey)).toBe(true);
      const channel = sseConnection.channels.get(fileKey);
      expect(channel.ownerId).toBe(userId);
      expect(channel.fileName).toBe("blood_report.pdf");

      // Verify that initial state event was buffered into channel
      expect(channel.buffer.length).toBeGreaterThanOrEqual(1);
      expect(channel.buffer[0].percentage).toBe(35);
      expect(res.write).toHaveBeenCalled();

      req.emit("close");
    });

    it("should return 404 when document is not in memory AND not in database", async () => {
      const fileKey = "file_non_existent";
      const userId = "user_patient_999";

      documentProcessingJobRepository.findByFileKey.mockResolvedValue(null);

      const req = {
        params: { fileKey },
        auth: { userId },
      };

      const res = {
        statusCode: 200,
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await sseController.streamFile(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "FAILED",
          message: "Document not found or stream expired",
        }),
      );
    });
  });
});
