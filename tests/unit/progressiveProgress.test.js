jest.mock("pdf-parse", () => {
  return jest.fn(async (buffer) => {
    if (!buffer || buffer.length === 0) {
      throw new Error("Invalid buffer");
    }
    const str = buffer.toString();
    if (str.includes("corrupt")) {
      throw new Error("Malformed PDF data");
    }
    if (str.includes("20pages")) {
      return { numpages: 20 };
    }
    if (str.includes("5pages")) {
      return { numpages: 5 };
    }
    return { numpages: 1 };
  });
});

const sseConnection = require("../../src/services/sseConnection.service");
const { ProgressEmitter } = require("../../src/services/progressEmitter.service");
const {
  DOCUMENT_STAGES,
  STAGE_WEIGHTS,
} = require("../../src/constants/documentProgress.constants");
const { StageType } = require("../../src/enums/stageStatus");
const { getPageCount } = require("../../src/utils/fileUtils");
const { ocrOrchestrator } = require("../../src/services/ai/ocr/ocr.orchestrator");
const { ocrService } = require("../../src/services/ai/ocr/ocr.service");

describe("Page-Wise Progressive SSE Feedback Unit Tests", () => {
  beforeEach(() => {
    sseConnection.destroy();
    sseConnection.sweepTimer = setInterval(() => sseConnection.sweepChannels(), 60 * 1000);
    sseConnection.sweepTimer.unref?.();
  });

  afterEach(() => {
    sseConnection.destroy();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    sseConnection.destroy();
  });

  describe("1. 20-Page Document Ingestion Progression (REQ-06)", () => {
    test("Smooth monotonic percentage progression across 20 pages without stage freezing", () => {
      const fileKey = "doc_20page_test";
      const totalPages = 20;
      const events = [];

      sseConnection.subscribe(fileKey, (ev) => events.push(ev));

      const emitter = ProgressEmitter.for({
        fileKey,
        fileName: "20_page_medical_report.pdf",
        batchId: "bat_20page_test",
        patientId: "patient_001",
        totalPages,
      });

      // Pipeline stages leading to OCR
      emitter.stage(DOCUMENT_STAGES.QUEUED, StageType.STARTED, "Queued");
      emitter.stage(
        DOCUMENT_STAGES.VALIDATING,
        StageType.IN_PROGRESS,
        "Validating format and medical intent",
      );
      emitter.stage(DOCUMENT_STAGES.UPLOADING, StageType.IN_PROGRESS, "Uploaded to object storage");

      const [ocrStart, ocrEnd] = STAGE_WEIGHTS[DOCUMENT_STAGES.OCR_RUNNING];
      expect(ocrStart).toBe(15);
      expect(ocrEnd).toBe(55);

      // Simulate 20 pages completing OCR sequentially
      const pagePercentages = [];
      for (let page = 1; page <= totalPages; page++) {
        const ev = emitter.page(page, totalPages, { message: `OCR Page ${page} of ${totalPages}` });
        pagePercentages.push(ev.percentage);
      }

      // Complete pipeline
      emitter.stage(DOCUMENT_STAGES.FIELD_EXTRACTION, StageType.IN_PROGRESS, "Structuring fields");
      emitter.stage(
        DOCUMENT_STAGES.SUMMARIZING,
        StageType.IN_PROGRESS,
        "Generating clinical summary",
      );
      emitter.done("Done");

      // Verify each page percentage is strictly non-decreasing
      for (let i = 1; i < pagePercentages.length; i++) {
        expect(pagePercentages[i]).toBeGreaterThanOrEqual(pagePercentages[i - 1]);
      }

      // Page 1: 15 + (1/20)*(55-15) = 15 + 2 = 17%
      expect(pagePercentages[0]).toBe(17);
      // Page 10: 15 + (10/20)*40 = 15 + 20 = 35%
      expect(pagePercentages[9]).toBe(35);
      // Page 20: 15 + (20/20)*40 = 15 + 40 = 55%
      expect(pagePercentages[19]).toBe(55);

      // Verify event metadata
      const ocrEvents = events.filter((e) => e.stage === DOCUMENT_STAGES.OCR_RUNNING);
      expect(ocrEvents.length).toBe(totalPages);
      ocrEvents.forEach((e, idx) => {
        expect(e.page).toBe(idx + 1);
        expect(e.totalPages).toBe(totalPages);
        expect(e.progress).toBe(pagePercentages[idx]);
      });
    });

    test("Out-of-order page completion guarantees monotonic progress without back-jumping", () => {
      const fileKey = "doc_ooo_test";
      const totalPages = 5;
      const emittedPercentages = [];

      sseConnection.subscribe(fileKey, (ev) => emittedPercentages.push(ev.percentage));

      const emitter = ProgressEmitter.for({
        fileKey,
        fileName: "out_of_order_scan.pdf",
        batchId: "bat_ooo_test",
        patientId: "patient_002",
        totalPages,
      });

      // Pages finish out of order: 1, 4, 2, 5, 3
      const finishOrder = [1, 4, 2, 5, 3];
      finishOrder.forEach((page) => {
        emitter.page(page, totalPages);
      });

      // Percentages must NEVER decrease
      for (let i = 1; i < emittedPercentages.length; i++) {
        expect(emittedPercentages[i]).toBeGreaterThanOrEqual(emittedPercentages[i - 1]);
      }
    });
  });

  describe("2. getPageCount Helper (PDF & Image Inspection)", () => {
    test("Returns 1 for null, undefined, or empty inputs", async () => {
      expect(await getPageCount(null)).toBe(1);
      expect(await getPageCount(undefined)).toBe(1);
      expect(await getPageCount("")).toBe(1);
      expect(await getPageCount({})).toBe(1);
    });

    test("Returns 1 for image files / buffers", async () => {
      const imgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic header
      expect(await getPageCount(imgBuffer)).toBe(1);

      const fileObj = {
        mimetype: "image/jpeg",
        originalname: "blood_test.jpg",
        buffer: imgBuffer,
      };
      expect(await getPageCount(fileObj)).toBe(1);
    });

    test("Safely defaults to 1 for corrupted or malformed PDF data without crashing", async () => {
      const corruptPdf = Buffer.from("%PDF-1.4 corrupt content that cannot parse");
      const count = await getPageCount(corruptPdf);
      expect(count).toBe(1);
    });

    test("Extracts page count from valid PDF buffer using pdf-parse", async () => {
      const mockMultiPageBuffer = Buffer.from("%PDF-1.4 20pages document content");
      const result = await getPageCount({
        mimetype: "application/pdf",
        originalname: "hospital_discharge_summary.pdf",
        buffer: mockMultiPageBuffer,
      });
      expect(result).toBe(20);

      const mock5PageBuffer = Buffer.from("%PDF-1.4 5pages document content");
      const result5 = await getPageCount({
        mimetype: "application/pdf",
        originalname: "lab_results.pdf",
        buffer: mock5PageBuffer,
      });
      expect(result5).toBe(5);
    });
  });

  describe("3. ProgressEmitter stage and page granularity", () => {
    test("progressWithinStage calculates precise ratio within stage boundaries", () => {
      const fileKey = "doc_granularity_test";
      const events = [];
      sseConnection.subscribe(fileKey, (ev) => events.push(ev));

      const emitter = ProgressEmitter.for({
        fileKey,
        fileName: "test.pdf",
        batchId: "bat_test",
        patientId: "p1",
      });

      // FIELD_EXTRACTION range is [56, 80] -> span 24
      // 0 of 4 -> 56
      const ev0 = emitter.progressWithinStage(
        DOCUMENT_STAGES.FIELD_EXTRACTION,
        0,
        4,
        "Field step 0",
      );
      expect(ev0.percentage).toBe(56);

      // 2 of 4 -> 56 + (2/4)*24 = 56 + 12 = 68
      const ev2 = emitter.progressWithinStage(
        DOCUMENT_STAGES.FIELD_EXTRACTION,
        2,
        4,
        "Field step 2",
      );
      expect(ev2.percentage).toBe(68);

      // 4 of 4 -> 56 + 24 = 80
      const ev4 = emitter.progressWithinStage(
        DOCUMENT_STAGES.FIELD_EXTRACTION,
        4,
        4,
        "Field step 4",
      );
      expect(ev4.percentage).toBe(80);
    });

    test("Clamps unitsDone greater than totalUnits safely", () => {
      const fileKey = "doc_clamping_test";
      const emitter = ProgressEmitter.for({
        fileKey,
        fileName: "test.pdf",
        batchId: "bat_test",
        patientId: "p1",
      });

      const evOver = emitter.progressWithinStage(
        DOCUMENT_STAGES.OCR_RUNNING,
        30,
        20,
        "Overrun page",
      );
      // Must not exceed upper bound of OCR_RUNNING (55)
      expect(evOver.percentage).toBe(55);
    });
  });

  describe("4. Orchestrator and Engine Page Progress Callback Propagation", () => {
    test("runFromBuffer passes onProgress callback to ocrService.extractMedicalData", async () => {
      const progressCalls = [];
      const onProgress = (info) => progressCalls.push(info);

      const fakeMedicalData = {
        pages: [
          { page: 1, text: "Patient: John Doe\nHb: 14.2 g/dL" },
          { page: 2, text: "Prescription: Paracetamol 500mg" },
        ],
        medicalExtraction: {
          patientInfo: { name: "John Doe" },
          hospitalInfo: { name: "City Clinic" },
          doctorInfo: { name: "Dr. Smith" },
          medications: [],
          labResults: [],
          vitals: [],
          summary: "Normal blood test",
        },
      };

      jest.spyOn(ocrService, "extractMedicalData").mockImplementation(async (file) => {
        // Simulate engine calling onProgress for each page
        file.onProgress?.({ page: 1, totalPages: 2, stage: "OCR_RUNNING" });
        file.onProgress?.({ page: 2, totalPages: 2, stage: "OCR_RUNNING" });
        return JSON.stringify(fakeMedicalData);
      });

      const fakeBuffer = Buffer.from("%PDF-1.4 test document");
      const result = await ocrOrchestrator.runFromBuffer({
        buffer: fakeBuffer,
        filename: "two_page_test.pdf",
        mimeType: "application/pdf",
        traceId: "trace_unit_test",
        onProgress,
      });

      expect(result.success).toBe(true);
      expect(result.ocr.pages.length).toBe(2);
      expect(progressCalls.length).toBe(2);
      expect(progressCalls[0]).toEqual({ page: 1, totalPages: 2, stage: "OCR_RUNNING" });
      expect(progressCalls[1]).toEqual({ page: 2, totalPages: 2, stage: "OCR_RUNNING" });
    });
  });
});
