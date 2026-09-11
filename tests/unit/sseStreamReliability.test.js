const { EventEmitter } = require("events");
const documentFlowController = require("../../src/controllers/documentFlow.controller");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const ocrProgressBus = require("../../src/services/sse/ocrProgressBus");
const { attachSseStream } = require("../../src/services/sse/sseTransport");
const { NotFoundException } = require("../../src/exceptions/appError");

jest.mock("../../src/repositories/documentProcessingJobRepository", () => ({
  findByFileKey: jest.fn(),
  reconcileRunningJobsOnBoot: jest.fn(),
  findStalledRunningJobs: jest.fn(),
  failStalledRunningJobs: jest.fn(),
}));

let activeHandles = [];

function createMockReqRes({
  fileKey = "test_file_001",
  userId = "user_123",
  headers = {},
  query = {},
} = {}) {
  const req = new EventEmitter();
  req.params = { fileKey };
  req.query = query;
  req.headers = headers;
  req.get = (headerName) => headers[headerName] || headers[headerName.toLowerCase()] || null;
  req.auth = { userId };

  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.written = [];
  res.setHeader = jest.fn((k, v) => {
    res.headers[k] = v;
  });
  res.flushHeaders = jest.fn();
  res.write = jest.fn((data) => {
    res.written.push(data);
    return true;
  });
  res.end = jest.fn(() => {
    res.ended = true;
    res.emit("close");
  });

  const pair = { req, res };
  activeHandles.push(pair);
  return pair;
}

const flushTicks = () => new Promise((resolve) => setImmediate(resolve));

describe("SSE Stream Reliability & Tenant Isolation Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ocrProgressBus.destroy();
    activeHandles = [];
  });

  afterEach(() => {
    for (const { req, res } of activeHandles) {
      if (!res.ended) {
        req.emit("close");
      }
    }
    ocrProgressBus.destroy();
  });

  describe("1. Tenant Isolation", () => {
    test("rejects access with NotFoundException if job does not belong to the user", async () => {
      documentProcessingJobRepository.findByFileKey.mockResolvedValue(null);

      const { req, res } = createMockReqRes({
        fileKey: "unauthorized_file.pdf",
        userId: "user_attacker",
      });

      await expect(documentFlowController.ocrProgressStream(req, res)).rejects.toThrow(
        NotFoundException,
      );
      expect(documentProcessingJobRepository.findByFileKey).toHaveBeenCalledWith(
        "unauthorized_file.pdf",
        "user_attacker",
      );
      expect(res.write).not.toHaveBeenCalled();
    });

    test("allows stream connection when user owns the document job", async () => {
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-1",
        fileKey: "authorized_file.pdf",
        userId: "user_owner",
        status: "RUNNING",
      });

      const { req, res } = createMockReqRes({
        fileKey: "authorized_file.pdf",
        userId: "user_owner",
      });

      await documentFlowController.ocrProgressStream(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("text/event-stream");
      expect(res.headers["Cache-Control"]).toBe("no-cache, no-transform");
      expect(res.written).toContain(": connected\n\n");
    });
  });

  describe("2. Standard SSE id: Field Emission & Reconnection", () => {
    test("emits id: <eventId> header when event contains eventId", () => {
      const { req, res } = createMockReqRes();
      const stream = attachSseStream(req, res);

      stream.write({ eventId: 42, stage: "VALIDATING", percentage: 20 });

      const output = res.written.join("");
      expect(output).toContain("id: 42\n");
      expect(output).toContain("event: progress\n");
      expect(output).toContain('"eventId":42');

      stream.close();
    });

    test("replays only newer events when reconnecting with Last-Event-ID", () => {
      const fileKey = "replay_doc.pdf";

      // Publish 3 events prior to client subscription
      ocrProgressBus.publish(fileKey, { stage: "QUEUED", percentage: 10 });
      ocrProgressBus.publish(fileKey, { stage: "OCR_RUNNING", percentage: 40 });
      ocrProgressBus.publish(fileKey, { stage: "SUMMARIZING", percentage: 80 });

      const received = [];
      const unsubscribe = ocrProgressBus.subscribe(
        fileKey,
        (ev) => received.push(ev),
        { sinceEventId: 2 }, // Client already has eventId 1 and 2
      );

      expect(received).toHaveLength(1);
      expect(received[0].eventId).toBe(3);
      expect(received[0].stage).toBe("SUMMARIZING");

      unsubscribe();
    });
  });

  describe("3. Terminal Auto-Close & Lifecycle Teardown", () => {
    test("automatically closes stream and ends response when COMPLETED event is published", async () => {
      const fileKey = "completed_doc.pdf";
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-comp",
        fileKey,
        userId: "user_123",
        status: "RUNNING",
      });

      const { req, res } = createMockReqRes({ fileKey, userId: "user_123" });
      await documentFlowController.ocrProgressStream(req, res);

      // Publish intermediate event
      ocrProgressBus.publish(fileKey, { stage: "OCR_RUNNING", percentage: 50 });
      expect(res.end).not.toHaveBeenCalled();

      // Publish terminal COMPLETED event
      ocrProgressBus.publish(fileKey, { stage: "COMPLETED", percentage: 100 });

      // Allow setImmediate to run terminal close
      await flushTicks();

      expect(res.end).toHaveBeenCalled();
    });

    test("automatically closes stream when FAILED event is published", async () => {
      const fileKey = "failed_doc.pdf";
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-fail",
        fileKey,
        userId: "user_123",
        status: "RUNNING",
      });

      const { req, res } = createMockReqRes({ fileKey, userId: "user_123" });
      await documentFlowController.ocrProgressStream(req, res);

      ocrProgressBus.publish(fileKey, { stage: "FAILED", error: "Corrupted PDF" });

      await flushTicks();

      expect(res.end).toHaveBeenCalled();
    });

    test("unsubscribes and cleans up channel when client disconnects", async () => {
      const fileKey = "disconnect_doc.pdf";
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-disc",
        fileKey,
        userId: "user_123",
        status: "RUNNING",
      });

      const { req, res } = createMockReqRes({ fileKey, userId: "user_123" });
      await documentFlowController.ocrProgressStream(req, res);

      const statsBefore = ocrProgressBus.getStats();
      expect(statsBefore.subscribers).toBe(1);

      // Simulate client navigation away / disconnect
      req.emit("close");

      const statsAfter = ocrProgressBus.getStats();
      expect(statsAfter.subscribers).toBe(0);
    });

    test("emits synthetic terminal event and closes if database job is already COMPLETED", async () => {
      const fileKey = "already_finished.pdf";
      documentProcessingJobRepository.findByFileKey.mockResolvedValue({
        id: "job-done",
        fileKey,
        userId: "user_123",
        status: "COMPLETED",
        stage: "COMPLETED",
        percentage: 100,
        extractedStructuredData: { summary: "Healthy report" },
      });

      const { req, res } = createMockReqRes({ fileKey, userId: "user_123" });
      await documentFlowController.ocrProgressStream(req, res);

      await flushTicks();

      expect(res.end).toHaveBeenCalled();
      const output = res.written.join("");
      expect(output).toContain('"stage":"COMPLETED"');
      expect(output).toContain('"percentage":100');
    });
  });
});
