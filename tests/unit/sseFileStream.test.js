const sseConnection = require("../../src/services/sseConnection.service");
const { ProgressEmitter } = require("../../src/services/progressEmitter.service");
const { DOCUMENT_STAGES } = require("../../src/constants/documentProgress.constants");
const { StageType, ProcessStatus } = require("../../src/enums/stageStatus");
const sseController = require("../../src/controllers/sse.controller");

describe("Individual File-Level SSE Progress Tracking Unit Tests", () => {
  beforeEach(() => {
    sseConnection.destroy();
    // Reinitialize timer
    sseConnection.sweepTimer = setInterval(() => sseConnection.sweepChannels(), 60 * 1000);
    sseConnection.sweepTimer.unref?.();
  });

  afterEach(() => {
    sseConnection.destroy();
  });

  afterAll(() => {
    sseConnection.destroy();
  });

  test("1. Single document stream receives sequential progress and completes cleanly", () => {
    const fileKey = "doc_single_001";
    const batchId = "bat_test_001";
    const events = [];
    let terminalCalled = false;

    const unsubscribe = sseConnection.subscribe(fileKey, (event) => events.push(event), {
      onTerminal: () => {
        terminalCalled = true;
      },
    });

    const emitter = ProgressEmitter.for({
      fileKey,
      fileName: "lab_report.pdf",
      batchId,
      patientId: "patient_123",
    });

    emitter.stage(DOCUMENT_STAGES.QUEUED, StageType.STARTED, "Queued");
    emitter.stage(DOCUMENT_STAGES.VALIDATING, StageType.IN_PROGRESS, "Validating");
    emitter.stage(DOCUMENT_STAGES.OCR_RUNNING, StageType.IN_PROGRESS, "Extracting text");
    emitter.page(1, 2);
    emitter.stage(DOCUMENT_STAGES.SUMMARIZING, StageType.IN_PROGRESS, "Summarizing");
    emitter.done("Done");

    expect(events.length).toBeGreaterThanOrEqual(5);

    // Verify all events belong strictly to doc_single_001
    for (const ev of events) {
      expect(ev.fileKey).toBe(fileKey);
      expect(ev.batchId).toBe(batchId);
      expect(ev.fileName).toBe("lab_report.pdf");
      expect(typeof ev.progress).toBe("number");
      expect(typeof ev.percentage).toBe("number");
      expect(ev.progress).toBe(ev.percentage);
      expect(ev.progress).toBeGreaterThanOrEqual(0);
      expect(ev.progress).toBeLessThanOrEqual(100);
    }

    // Verify terminal event
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("document.completed");
    expect(lastEvent.stage).toBe(StageType.COMPLETED);
    expect(lastEvent.stageStatus).toBe(StageType.COMPLETED);
    expect(lastEvent.progress).toBe(100);
    expect(terminalCalled).toBe(true);

    unsubscribe();
  });

  test("2. Single document validation failure terminates with document.failed", () => {
    const fileKey = "doc_fail_002";
    const batchId = "bat_test_002";
    const events = [];
    let terminalCalled = false;

    const unsubscribe = sseConnection.subscribe(fileKey, (event) => events.push(event), {
      onTerminal: () => {
        terminalCalled = true;
      },
    });

    const emitter = ProgressEmitter.for({
      fileKey,
      fileName: "utility_bill.pdf",
      batchId,
      patientId: "patient_123",
    });

    emitter.stage(DOCUMENT_STAGES.VALIDATING, StageType.IN_PROGRESS, "Validating");
    emitter.error(DOCUMENT_STAGES.VALIDATING, "Uploaded file is not a valid medical document");

    expect(events.length).toBe(2);

    const failEvent = events[1];
    expect(failEvent.type).toBe("document.failed");
    expect(failEvent.fileKey).toBe(fileKey);
    expect(failEvent.stage).toBe(DOCUMENT_STAGES.VALIDATING);
    expect(failEvent.stageStatus).toBe(StageType.FAILED);
    expect(failEvent.status).toBe(ProcessStatus.FAILED);
    expect(failEvent.message).toBe("Uploaded file is not a valid medical document");
    expect(terminalCalled).toBe(true);

    unsubscribe();
  });

  test("3. Zero Cross-Talk between multiple file streams in the same batch", () => {
    const batchId = "bat_multi_003";
    const fileKeys = ["doc_alpha", "doc_beta", "doc_gamma"];

    sseConnection.registerBatch(batchId, fileKeys);

    const alphaEvents = [];
    const betaEvents = [];
    const gammaEvents = [];

    const unsubs = [
      sseConnection.subscribe("doc_alpha", (e) => alphaEvents.push(e)),
      sseConnection.subscribe("doc_beta", (e) => betaEvents.push(e)),
      sseConnection.subscribe("doc_gamma", (e) => gammaEvents.push(e)),
    ];

    const emitterAlpha = ProgressEmitter.for({
      fileKey: "doc_alpha",
      fileName: "alpha.pdf",
      batchId,
    });
    const emitterBeta = ProgressEmitter.for({ fileKey: "doc_beta", fileName: "beta.pdf", batchId });
    const emitterGamma = ProgressEmitter.for({
      fileKey: "doc_gamma",
      fileName: "gamma.pdf",
      batchId,
    });

    // Interleave events across the 3 files
    emitterAlpha.stage(DOCUMENT_STAGES.QUEUED, StageType.STARTED);
    emitterBeta.stage(DOCUMENT_STAGES.QUEUED, StageType.STARTED);
    emitterGamma.stage(DOCUMENT_STAGES.QUEUED, StageType.STARTED);

    emitterBeta.stage(DOCUMENT_STAGES.VALIDATING, StageType.IN_PROGRESS);
    emitterBeta.stage(DOCUMENT_STAGES.OCR_RUNNING, StageType.IN_PROGRESS);
    emitterBeta.done();

    emitterAlpha.stage(DOCUMENT_STAGES.OCR_RUNNING, StageType.IN_PROGRESS);
    emitterAlpha.done();

    emitterGamma.error(DOCUMENT_STAGES.VALIDATING, "Invalid format");

    // Assert alpha stream contains ONLY doc_alpha
    expect(alphaEvents.length).toBe(3);
    for (const ev of alphaEvents) {
      expect(ev.fileKey).toBe("doc_alpha");
    }

    // Assert beta stream contains ONLY doc_beta
    expect(betaEvents.length).toBe(4);
    for (const ev of betaEvents) {
      expect(ev.fileKey).toBe("doc_beta");
    }

    // Assert gamma stream contains ONLY doc_gamma
    expect(gammaEvents.length).toBe(2);
    for (const ev of gammaEvents) {
      expect(ev.fileKey).toBe("doc_gamma");
    }

    unsubs.forEach((u) => u());
  });

  test("4. Last-Event-ID replay replays only newer buffered events without duplicates", () => {
    const fileKey = "doc_replay_004";
    const emitter = ProgressEmitter.for({ fileKey, fileName: "test.pdf" });

    emitter.stage(DOCUMENT_STAGES.QUEUED, StageType.STARTED);
    emitter.stage(DOCUMENT_STAGES.VALIDATING, StageType.IN_PROGRESS);
    emitter.stage(DOCUMENT_STAGES.OCR_RUNNING, StageType.IN_PROGRESS);
    emitter.stage(DOCUMENT_STAGES.ANALYZING, StageType.IN_PROGRESS);
    emitter.stage(DOCUMENT_STAGES.SUMMARIZING, StageType.IN_PROGRESS);

    // Subscribe with sinceEventId = 3 (should replay events with eventId > 3)
    const replayedEvents = [];
    const unsubscribe = sseConnection.subscribe(fileKey, (event) => replayedEvents.push(event), {
      sinceEventId: 3,
    });

    expect(replayedEvents.length).toBe(2);
    expect(replayedEvents[0].eventId).toBe(4);
    expect(replayedEvents[1].eventId).toBe(5);

    unsubscribe();
  });

  test("5. Controller streamFile verifies ownership and handles unauthorized access", () => {
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };

    // Test unauthorized request
    const unauthorizedReq = {
      params: { fileKey: "doc_unauthorized_999" },
      auth: { userId: "user_attacker" },
      get: jest.fn().mockReturnValue(null),
      query: {},
      on: jest.fn(),
    };

    // Create channel owned by user_victim
    const channel = sseConnection.getOrCreate("doc_unauthorized_999", false);
    channel.ownerId = "user_victim";

    sseController.streamFile(unauthorizedReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        message: expect.stringContaining("Unauthorized"),
      }),
    );

    // Test authorized request
    const authorizedRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
    };
    const authorizedReq = {
      params: { fileKey: "doc_unauthorized_999" },
      auth: { userId: "user_victim" },
      get: jest.fn().mockReturnValue(null),
      query: {},
      on: jest.fn(),
    };

    sseController.streamFile(authorizedReq, authorizedRes);
    expect(authorizedRes.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/event-stream; charset=utf-8",
    );
    expect(authorizedRes.write).toHaveBeenCalledWith(
      expect.stringContaining("event: stream.connected"),
    );
  });
});
