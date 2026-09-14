const { stripThinking } = require("../../src/utils/textCleanUtils");
const { ollamaClient } = require("../../src/clients/ollamaClient");
const { buildChunks } = require("../../src/helpers/embedding.helper");
const { embeddingService } = require("../../src/services/ai/chat/embedding.service");

describe("Hotfix HF-1: Reproduction Test T-A (Stop Embedding Reasoning)", () => {
  describe("1. stripThinking Utility", () => {
    test("should strip standard <think>...</think> tags and return only the final text", () => {
      const input = "<think>reasoning</think>FINAL";
      const output = stripThinking(input);
      expect(output).toBe("FINAL");
      expect(output).not.toContain("<think>");
      expect(output).not.toContain("reasoning");
    });

    test("should strip multiline <think> blocks with linebreaks and formatting", () => {
      const input = `<think>
Analyzing medical parameters:
1. Blood pressure: 140/90
2. Diagnosed as Stage 1 Hypertension
</think>
The patient has Stage 1 Hypertension and requires lifestyle modification.`;

      const output = stripThinking(input);
      expect(output).toBe(
        "The patient has Stage 1 Hypertension and requires lifestyle modification.",
      );
      expect(output).not.toContain("<think>");
      expect(output).not.toContain("Analyzing medical parameters");
    });

    test("should strip unclosed <think> tag if model output was cut off", () => {
      const input = "<think>Incomplete reasoning that was cut off by token limit";
      const output = stripThinking(input);
      expect(output).toBe("");
    });

    test("should preserve clean multilingual text in Indic scripts without alteration", () => {
      const hindiText = "रोगी को उच्च रक्तचाप की समस्या है।";
      const gujaratiText = "દર્દીને હાઈ બ્લડ પ્રેશરની સમસ્યા છે.";
      expect(stripThinking(hindiText)).toBe(hindiText);
      expect(stripThinking(gujaratiText)).toBe(gujaratiText);
    });
  });

  describe("2. ollamaClient.extractResponseText", () => {
    test("should automatically strip <think> blocks from chat response message.content", () => {
      const rawData = {
        message: {
          content: "<think>Translating prescription to Gujarati</think>દરરોજ એક ગોળી લો.",
        },
      };

      const extracted = ollamaClient.extractResponseText(rawData, "chat");
      expect(extracted).toBe("દરરોજ એક ગોળી લો.");
      expect(extracted).not.toContain("<think>");
      expect(extracted).not.toContain("Translating");
    });

    test("should automatically strip <think> blocks from generate response body", () => {
      const rawData = {
        response: "<think>Synthesizing clinical findings</think>Normal CBC and Lipid profile.",
      };

      const extracted = ollamaClient.extractResponseText(rawData, "generate");
      expect(extracted).toBe("Normal CBC and Lipid profile.");
      expect(extracted).not.toContain("<think>");
      expect(extracted).not.toContain("Synthesizing");
    });

    test("should not leak raw internal thinking when primary text is empty", () => {
      const rawData = {
        response: "",
        thinking: "internal chain of thought reasoning",
      };

      expect(() => {
        ollamaClient.extractResponseText(rawData, "generate", { fallbackToThinking: false });
      }).toThrow();
    });
  });

  describe("3. Embeddings & Chunking Pipeline (No Reasoning in Embeddings)", () => {
    test("buildChunks must strip <think> blocks from structured.summary", () => {
      const structured = {
        summary:
          "<think>Model reasoning about diabetes medication</think>Patient prescribed Metformin 500mg daily.",
      };

      const chunks = buildChunks({ rawOcr: null, structured });
      const summaryChunk = chunks.find((c) => c.sourceType === "summary");

      expect(summaryChunk).toBeDefined();
      expect(summaryChunk.content).toBe("Patient prescribed Metformin 500mg daily.");
      expect(summaryChunk.content).not.toContain("<think>");
      expect(summaryChunk.content).not.toContain("Model reasoning");
    });

    test("embedAndPersist sends only FINAL clinical text to ollamaClient.embeddings / embed", async () => {
      const embedSpy = jest
        .spyOn(ollamaClient, "embeddings")
        .mockResolvedValue(new Array(1024).fill(0.01));

      const mockRepo = {
        deleteForDocument: jest.fn().mockResolvedValue(true),
        createChunks: jest
          .fn()
          .mockImplementation((chunks) => chunks.map((c, idx) => ({ ...c, id: `chunk-${idx}` }))),
        createEmbeddings: jest.fn().mockResolvedValue(true),
      };

      const structured = {
        summary: "<think>Internal trace: patient visited Dr. Shah</think>FINAL",
      };

      await embeddingService.embedAndPersist({
        documentId: "doc-123",
        userId: "user-123",
        rawOcr: null,
        structured,
        txRepository: mockRepo,
      });

      expect(embedSpy).toHaveBeenCalled();
      for (const call of embedSpy.mock.calls) {
        const textSentToEmbed = call[0];
        expect(textSentToEmbed).toBe("FINAL");
        expect(textSentToEmbed).not.toContain("<think>");
        expect(textSentToEmbed).not.toContain("Internal trace");
      }

      embedSpy.mockRestore();
    });
  });
});
