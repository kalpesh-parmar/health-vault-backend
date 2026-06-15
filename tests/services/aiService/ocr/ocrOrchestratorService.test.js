/* global describe, it, expect, jest */
const ocrOrchestratorService = require("../../../../src/services/aiService/ocr/ocrOrchestratorService");
const {
  evaluateQuality,
} = require("../../../../src/services/aiService/ocr/ocrOrchestratorService");
const { qwenVisionService } = require("../../../../src/services/ai/qwenVisionService.ts");
const { OcrEmptyResultError } = require("../../../../src/services/aiService/ocr/ocrErrors");

jest.mock("../../../../src/services/ai/qwenVisionService.ts");
jest.mock("../../../../src/services/objectStorageService");

describe("ocrOrchestratorService", () => {
  describe("evaluateQuality", () => {
    it("should reject results with short text", () => {
      const res = evaluateQuality({
        ocr_text: "abc",
        metadata: { confidence: 0.9, nonEmptyPages: 1 },
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("empty");
    });

    it("should reject results with low confidence", () => {
      const res = evaluateQuality({
        ocr_text: "this is some long text indeed",
        metadata: { confidence: 0.2, nonEmptyPages: 1 },
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("low_confidence");
    });

    it("should accept good quality results", () => {
      const res = evaluateQuality({
        ocr_text: "this is some long text indeed",
        metadata: { confidence: 0.85, nonEmptyPages: 1 },
      });
      expect(res.ok).toBe(true);
    });
  });

  describe("runFromBuffer", () => {
    it("should parse and return extraction when successful", async () => {
      const mockParsedOCR = {
        pages: [
          {
            page: 1,
            text: "this is some long text indeed Fasting Blood Sugar: 95 mg/dL",
            confidence: 0.9,
          },
        ],
        medicalExtraction: {
          patientInfo: {},
          hospitalInfo: {},
          doctorInfo: {},
          diagnosis: [],
          medications: [],
          labResults: [],
          vitals: [],
          recommendations: [],
          summary: "",
        },
      };

      qwenVisionService.extractMedicalData.mockResolvedValue(JSON.stringify(mockParsedOCR));

      const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46]); // PDF header
      const result = await ocrOrchestratorService.runFromBuffer({
        buffer,
        filename: "test.pdf",
        mimeType: "application/pdf",
      });

      expect(result.engine).toBe("ollama:qwen3-vl");
      expect(result.ocr_text).toContain("Fasting Blood Sugar");
      expect(result.metrics.primary_engine).toBe("ollama:qwen3-vl");
    });

    it("should throw OcrEmptyResultError if qwenVisionService fails", async () => {
      qwenVisionService.extractMedicalData.mockRejectedValue(new Error("Ollama connection error"));

      const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46]); // PDF header
      await expect(
        ocrOrchestratorService.runFromBuffer({
          buffer,
          filename: "test.pdf",
          mimeType: "application/pdf",
        }),
      ).rejects.toThrow(OcrEmptyResultError);
    });
  });
});
