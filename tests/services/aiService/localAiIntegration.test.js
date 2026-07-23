const axios = require("axios");
const { chatService } = require("../../../src/services/ai/chat/chat.service");
const { embeddingService } = require("../../../src/services/ai/chat/embedding.service");
const { EMERGENCY_WARNING } = require("../../../src/services/ai/prompts");

jest.mock("axios", () => {
  const mockAxios = jest.fn((config) => {
    if (config.method === "post") {
      return mockAxios.post(config.url, config.data, config);
    }
    return Promise.resolve({});
  });
  mockAxios.post = jest.fn();
  mockAxios.get = jest.fn();
  return mockAxios;
});

describe("Local AI + RAG Healthcare Assistant Integration Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Emergency Detection Flow", () => {
    it("should detect chest pain and trigger the emergency warning", async () => {
      const messages = [{ role: "user", content: "I am having severe chest pain right now" }];
      const result = await chatService.qwenHealthChat(messages, "GENERAL_HEALTH");

      expect(result.emergency).toBe(true);
      expect(result.answer).toContain("urgent medical attention");
      expect(result.answer).toEqual(EMERGENCY_WARNING);
    });

    it("should detect breathing difficulty and set emergency to true", async () => {
      const messages = [{ role: "user", content: "It is hard to breathe, difficulty breathing" }];
      const result = await chatService.qwenHealthChat(messages, "GENERAL_HEALTH");

      expect(result.emergency).toBe(true);
      expect(result.answer).toContain("urgent medical attention");
    });
  });

  describe("General Health Mode", () => {
    it("should call Ollama chat for general health queries when no emergency is detected", async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          message: {
            content:
              "Medical Facts:\nDiabetes is... \nRecommendations:\nAvoid sugar... \nEmergency Advice:\nSee doctor if unconscious.",
          },
        },
      });

      const messages = [{ role: "user", content: "Tell me about symptoms of diabetes" }];
      const result = await chatService.qwenHealthChat(messages, "GENERAL_HEALTH");

      expect(result.emergency).toBe(false);
      expect(result.answer).toContain("Medical Facts");
      expect(axios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe("Document RAG Mode", () => {
    it("should return the canonical missing info message if no context chunks are supplied", async () => {
      const messages = [{ role: "user", content: "What is my blood sugar level?" }];
      const result = await chatService.qwenHealthChat(messages, "DOCUMENT_RAG", []);

      expect(result.answer).toEqual("Information not found in uploaded reports.");
      expect(result.citations).toEqual([]);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it("should query Ollama chat with context when chunks are supplied", async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          message: {
            content:
              "Based on your reports, your glucose level is 110 mg/dL [Section: Lab Test, Chunk: c1, Similarity: 0.92].",
          },
        },
      });

      const chunks = [
        {
          chunkId: "c1",
          content: "Glucose Fasting: 110 mg/dL",
          sectionTitle: "Lab Test",
          score: 0.92,
          sourceType: "ocr_chunk",
        },
      ];
      const messages = [{ role: "user", content: "What is my glucose level?" }];
      const result = await chatService.qwenHealthChat(messages, "DOCUMENT_RAG", chunks);

      expect(result.answer).toContain("glucose level is 110 mg/dL");
      expect(result.citations).toHaveLength(1);
      expect(axios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe("Embeddings & Normalization Flow", () => {
    it("should return 1024-dimensional embeddings using local bge-m3:latest model", async () => {
      // Mock Ollama embeddings response with 1024 dimensions
      const mockVector = new Array(1024).fill(0.1);
      axios.post.mockResolvedValueOnce({
        data: {
          embedding: mockVector,
        },
      });

      const result = await embeddingService.embedText("test text");
      expect(result).toHaveLength(1024);
      expect(result[0]).toBe(0.1);
    });

    it("should normalize and truncate embeddings to exactly 1024 dimensions if they differ", async () => {
      const mockVector = new Array(1500).fill(0.25);
      axios.post.mockResolvedValueOnce({
        data: {
          embedding: mockVector,
        },
      });

      const result = await embeddingService.embedText("test text");
      expect(result).toHaveLength(1024);
      expect(result[0]).toBe(0.25);
    });
  });
});
