const {
  medicalDocumentClassifierService,
} = require("../../../../src/services/ai/classifier/medicalDocumentClassifier.service");
const { ollamaClient } = require("../../../../src/services/ai/clients/ollamaClient");

jest.mock("../../../../src/services/ai/clients/ollamaClient", () => {
  return {
    ollamaClient: {
      chat: jest.fn(),
      generate: jest.fn(),
    },
  };
});

describe("MedicalDocumentClassifierService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("cleanAndParseJSON", () => {
    it("should successfully parse valid JSON response", () => {
      const response = {
        content: JSON.stringify({
          isMedicalDocument: true,
          confidence: 0.95,
          documentType: "Prescription",
        }),
        done_reason: "stop",
      };

      const result = medicalDocumentClassifierService.cleanAndParseJSON(response);
      expect(result).toEqual({
        isMedicalDocument: true,
        confidence: 0.95,
        documentType: "Prescription",
        reason: null,
      });
    });

    it("should handle empty content gracefully and return descriptive error", () => {
      const response = {
        content: "",
        done_reason: "stop",
      };

      const result = medicalDocumentClassifierService.cleanAndParseJSON(response);
      expect(result.isMedicalDocument).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain("Empty response");
    });

    it("should handle thinking-only response (empty content, populated thinking)", () => {
      const response = {
        content: "",
        thinking: "<think>This is just internal thinking</think>",
        done_reason: "stop",
      };

      const result = medicalDocumentClassifierService.cleanAndParseJSON(response);
      expect(result.isMedicalDocument).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain("Empty response");
    });

    it("should handle truncated response (done_reason=length with empty content)", () => {
      const response = {
        content: "",
        thinking: "<think>Reasoning process that got cut off",
        done_reason: "length",
      };

      const result = medicalDocumentClassifierService.cleanAndParseJSON(response);
      expect(result.isMedicalDocument).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain("truncated due to output length limit");
    });

    it("should parse markdown-wrapped JSON", () => {
      const response = {
        content: `Some conversational text before.
\`\`\`json
{
  "isMedicalDocument": true,
  "confidence": 0.98,
  "documentType": "Lab Report"
}
\`\`\`
Some other text after.`,
        done_reason: "stop",
      };

      const result = medicalDocumentClassifierService.cleanAndParseJSON(response);
      expect(result).toEqual({
        isMedicalDocument: true,
        confidence: 0.98,
        documentType: "Lab Report",
        reason: null,
      });
    });

    it("should repair and parse malformed JSON (trailing commas, double commas)", () => {
      const response = {
        content: `{
          "isMedicalDocument": true,,
          "confidence": 0.90,
          "documentType": "Prescription",
        }`,
        done_reason: "stop",
      };

      const result = medicalDocumentClassifierService.cleanAndParseJSON(response);
      expect(result).toEqual({
        isMedicalDocument: true,
        confidence: 0.9,
        documentType: "Prescription",
        reason: null,
      });
    });

    it("should recover from partially truncated/broken JSON structures using stack repair", () => {
      const response = {
        content: `{
          "isMedicalDocument": true,
          "confidence": 0.85,
          "documentType": "CT Scan Report`, // Missing quote and closing brace
        done_reason: "stop",
      };

      const result = medicalDocumentClassifierService.cleanAndParseJSON(response);
      expect(result).toEqual({
        isMedicalDocument: true,
        confidence: 0.85,
        documentType: "CT Scan Report",
        reason: null,
      });
    });
  });

  describe("classify", () => {
    it("should query qwen3-vl:latest for images with structured JSON options", async () => {
      const fileMock = {
        buffer: Buffer.from("image_data"),
        mimeType: "image/png",
        originalname: "prescription.png",
      };

      ollamaClient.chat.mockResolvedValueOnce({
        content: JSON.stringify({
          isMedicalDocument: true,
          confidence: 0.96,
          documentType: "Prescription",
        }),
        done_reason: "stop",
      });

      const result = await medicalDocumentClassifierService.classify(fileMock);
      expect(ollamaClient.chat).toHaveBeenCalledWith(
        expect.any(Array),
        "qwen3-vl:latest",
        expect.objectContaining({
          temperature: 0,
          maxTokens: 2048,
          format: "json",
          fallbackToThinking: false,
          returnFullResponse: true,
        }),
      );
      expect(result.isMedicalDocument).toBe(true);
      expect(result.documentType).toBe("Prescription");
    });
  });
});
