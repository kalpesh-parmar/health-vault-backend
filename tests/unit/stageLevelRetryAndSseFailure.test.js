const sseConnection = require("../../src/services/sseConnection.service");
const ocrProgressBus = require("../../src/services/sse/ocrProgressBus");

describe("Stage-Level Retry & SSE Failure Handling Unit Tests", () => {
  const fileKey = "test_retry_doc.pdf";

  beforeEach(() => {
    sseConnection.channels.delete(fileKey);
    ocrProgressBus._channels.delete(fileKey);
  });

  afterEach(() => {
    sseConnection.channels.delete(fileKey);
    ocrProgressBus._channels.delete(fileKey);
  });

  test("1. SSE stream marks terminal and closes on terminal stageStatus FAILED event", () => {
    let closed = false;
    const receivedEvents = [];

    const unsubscribe = sseConnection.subscribe(fileKey, (evt) => receivedEvents.push(evt), {
      onTerminal: () => {
        closed = true;
      },
    });

    // Initial progress event
    sseConnection.publish(fileKey, {
      type: "document.progress",
      stage: "OCR_RUNNING",
      stageStatus: "IN_PROGRESS",
      percentage: 25,
      attemptCount: 1,
    });

    expect(closed).toBe(false);
    expect(sseConnection.isTerminal(fileKey)).toBe(false);

    // Terminal failure event from Python
    sseConnection.publish(fileKey, {
      type: "document.failed",
      stage: "OCR_RUNNING",
      stageStatus: "FAILED",
      percentage: 25,
      errorCode: "OCR_EXTRACTION_FAILED",
      failedStage: "OCR_RUNNING",
      retryable: true,
      attemptCount: 1,
      message: "OCR text extraction failed",
    });

    expect(closed).toBe(true);
    expect(sseConnection.isTerminal(fileKey)).toBe(true);
    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[1].stageStatus).toBe("FAILED");
    expect(receivedEvents[1].failedStage).toBe("OCR_RUNNING");

    unsubscribe();
  });

  test("2. Stale worker events from an older attemptCount are discarded", () => {
    const receivedEvents = [];
    sseConnection.subscribe(fileKey, (evt) => receivedEvents.push(evt));

    // Attempt 2 starts
    sseConnection.publish(fileKey, {
      type: "document.retrying",
      stage: "OCR_RUNNING",
      stageStatus: "QUEUED",
      percentage: 25,
      attemptCount: 2,
    });

    expect(receivedEvents).toHaveLength(1);

    // Stale late event arriving from attempt 1
    const discarded = sseConnection.publish(fileKey, {
      type: "document.progress",
      stage: "OCR_RUNNING",
      stageStatus: "IN_PROGRESS",
      percentage: 20,
      attemptCount: 1,
    });

    expect(discarded).toBeNull();
    expect(receivedEvents).toHaveLength(1); // Not appended to buffer or subscribers
  });

  test("3. Reopen clears terminal flag when retry is initiated", () => {
    // Channel starts and fails
    sseConnection.publish(fileKey, {
      type: "document.failed",
      stage: "SUMMARIZING",
      stageStatus: "FAILED",
      percentage: 85,
      attemptCount: 1,
    });
    expect(sseConnection.isTerminal(fileKey)).toBe(true);

    // User retries -> channel is reopened
    const channel = sseConnection.reopen(fileKey);
    expect(channel.terminal).toBe(false);
    expect(sseConnection.isTerminal(fileKey)).toBe(false);

    // Can receive new progress for attempt 2
    let terminalFired = false;
    sseConnection.subscribe(fileKey, () => {}, {
      onTerminal: () => {
        terminalFired = true;
      },
    });

    sseConnection.publish(fileKey, {
      type: "document.progress",
      stage: "SUMMARIZING",
      stageStatus: "IN_PROGRESS",
      percentage: 90,
      attemptCount: 2,
    });

    expect(terminalFired).toBe(false);
  });

  test("4. ocrProgressBus also marks terminal on stageStatus FAILED and triggers onTerminal", () => {
    let closed = false;
    ocrProgressBus.subscribe(fileKey, () => {}, {
      onTerminal: () => {
        closed = true;
      },
    });

    ocrProgressBus.publish(fileKey, {
      stage: "OCR_RUNNING",
      stageStatus: "FAILED",
      errorCode: "OCR_EXTRACTION_FAILED",
      message: "OCR failed",
    });

    expect(closed).toBe(true);
    expect(ocrProgressBus.isTerminal(fileKey)).toBe(true);
  });
});
