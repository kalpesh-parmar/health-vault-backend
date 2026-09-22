const { normalizeLanguage } = require("../../src/utils/commonUtils");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const patientRepository = require("../../src/repositories/patientRepository");
require("../../src/repositories/medicationRepository");
require("../../src/repositories/documentRepository");
const occurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const { ollamaClient } = require("../../src/clients/ollamaClient");
const aiClient = require("../../src/services/ai/clients/aiClient.service");
const { chatService } = require("../../src/services/ai/chat/chat.service");

jest.mock("../../src/repositories/chatSessionRepository");
jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/clients/ollamaClient");
jest.mock("../../src/services/ai/clients/aiClient.service");
jest.mock("../../src/services/ai/chat/embedding.service", () => ({
  embeddingService: {
    embedText: jest.fn().mockResolvedValue(new Array(1024).fill(0.01)),
  },
}));
jest.mock("../../src/services/ai/chat/ragContext.service", () => {
  const actual = jest.requireActual("../../src/services/ai/chat/ragContext.service");
  return {
    ...actual,
    ragContextService: {
      retrieveRagContext: jest.fn().mockResolvedValue({
        summaryChunks: [],
        coverageStr: "",
      }),
    },
    buildDependencyAwareContext: jest.fn().mockResolvedValue("=== PATIENT CONTEXT ==="),
  };
});
jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    })),
  },
}));

describe("Chat Translation Gateway & Language Normalization", () => {
  const mockUserId = "user-trans-123";
  const mockSessionId = "sess-trans-456";

  beforeEach(() => {
    jest.clearAllMocks();

    patientRepository.findById.mockResolvedValue({
      id: mockUserId,
      firstName: "Aarav",
      lastName: "Sharma",
      preferredLanguage: "english",
      dateOfBirth: new Date("1985-05-20"),
    });

    chatSessionRepository.findSessionById.mockResolvedValue({
      id: mockSessionId,
      userId: mockUserId,
      metadata: {},
    });

    chatSessionRepository.listSessions.mockResolvedValue({
      items: [{ id: mockSessionId }],
    });

    chatSessionRepository.listMessages.mockResolvedValue({
      items: [],
    });

    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: `msg-${Date.now()}`,
      ...msg,
    }));

    if (occurrenceRepository.findTodayOccurrences) {
      occurrenceRepository.findTodayOccurrences.mockResolvedValue([]);
    }

    ollamaClient.chat.mockResolvedValue("General health response");
    ollamaClient.chatStream.mockImplementation(async (messages, model, onChunk) => {
      onChunk("General health response stream");
      return { model: "qwen2.5:14b", done: true };
    });
  });

  describe("normalizeLanguage()", () => {
    test("normalizes all 5 languages and standard aliases correctly", () => {
      // English
      expect(normalizeLanguage("en")).toBe("english");
      expect(normalizeLanguage("eng")).toBe("english");
      expect(normalizeLanguage("english")).toBe("english");
      expect(normalizeLanguage("English")).toBe("english");

      // Gujarati
      expect(normalizeLanguage("gu")).toBe("gujarati");
      expect(normalizeLanguage("guj")).toBe("gujarati");
      expect(normalizeLanguage("gujarati")).toBe("gujarati");

      // Hindi
      expect(normalizeLanguage("hi")).toBe("hindi");
      expect(normalizeLanguage("hin")).toBe("hindi");
      expect(normalizeLanguage("hindi")).toBe("hindi");

      // Marathi
      expect(normalizeLanguage("mr")).toBe("marathi");
      expect(normalizeLanguage("mar")).toBe("marathi");
      expect(normalizeLanguage("marathi")).toBe("marathi");

      // Tamil
      expect(normalizeLanguage("ta")).toBe("tamil");
      expect(normalizeLanguage("tam")).toBe("tamil");
      expect(normalizeLanguage("tamil")).toBe("tamil");

      // Fallback
      expect(normalizeLanguage(null)).toBe("english");
      expect(normalizeLanguage(undefined)).toBe("english");
      expect(normalizeLanguage("")).toBe("english");
      expect(normalizeLanguage("spanish")).toBe("english");
    });
  });

  describe("Early Auxiliary Query Translation in sendMessage()", () => {
    test("translates Hindi query to English for internal processing while preserving raw question and detectedLanguage", async () => {
      const rawHindiQuestion = "क्या मुझे आज कोई दवा लेनी है?";
      const translatedEnglish = "Do I need to take any medication today?";

      aiClient.detectLanguage.mockResolvedValue("hindi");
      aiClient.translate.mockResolvedValue(translatedEnglish);

      let capturedCtx = null;
      const originalResolveSession = chatService._resolveSession;
      chatService._resolveSession = jest.fn(async (ctx) => {
        capturedCtx = { ...ctx };
        return originalResolveSession.call(chatService, ctx);
      });

      try {
        const result = await chatService.sendMessage({
          userId: mockUserId,
          question: rawHindiQuestion,
          sessionId: mockSessionId,
        });

        expect(aiClient.detectLanguage).toHaveBeenCalledWith(rawHindiQuestion);
        expect(aiClient.translate).toHaveBeenCalledWith(rawHindiQuestion, "hindi", "english");

        expect(capturedCtx).toBeDefined();
        expect(capturedCtx.question).toBe(rawHindiQuestion);
        expect(capturedCtx.detectedLanguage).toBe("hindi");
        expect(capturedCtx.englishQuestion).toBe(translatedEnglish);
        expect(capturedCtx.cleanEnglishQuestion).toBe("do i need to take any medication today");
        expect(capturedCtx.retrievalQuery).toBe(translatedEnglish);
        expect(result).toBeDefined();
      } finally {
        chatService._resolveSession = originalResolveSession;
      }
    });

    test("bypasses translation if detectedLanguage is english", async () => {
      const englishQuestion = "What should I eat for high blood pressure?";

      aiClient.detectLanguage.mockResolvedValue("english");

      let capturedCtx = null;
      const originalResolveSession = chatService._resolveSession;
      chatService._resolveSession = jest.fn(async (ctx) => {
        capturedCtx = { ...ctx };
        return originalResolveSession.call(chatService, ctx);
      });

      try {
        await chatService.sendMessage({
          userId: mockUserId,
          question: englishQuestion,
          sessionId: mockSessionId,
        });

        expect(aiClient.detectLanguage).toHaveBeenCalledWith(englishQuestion);
        expect(aiClient.translate).not.toHaveBeenCalled();

        expect(capturedCtx).toBeDefined();
        expect(capturedCtx.question).toBe(englishQuestion);
        expect(capturedCtx.englishQuestion).toBe(englishQuestion);
        expect(capturedCtx.cleanEnglishQuestion).toBe("what should i eat for high blood pressure");
        expect(capturedCtx.detectedLanguage).toBe("english");
      } finally {
        chatService._resolveSession = originalResolveSession;
      }
    });

    test("fails open if aiClient.translate throws an error", async () => {
      const rawGujaratiQuestion = "મને માથાનો દુખાવો છે";

      aiClient.detectLanguage.mockResolvedValue("gujarati");
      aiClient.translate.mockRejectedValue(new Error("Translation service timeout"));

      let capturedCtx = null;
      const originalResolveSession = chatService._resolveSession;
      chatService._resolveSession = jest.fn(async (ctx) => {
        capturedCtx = { ...ctx };
        return originalResolveSession.call(chatService, ctx);
      });

      try {
        const result = await chatService.sendMessage({
          userId: mockUserId,
          question: rawGujaratiQuestion,
          sessionId: mockSessionId,
        });

        expect(capturedCtx).toBeDefined();
        expect(capturedCtx.question).toBe(rawGujaratiQuestion);
        expect(capturedCtx.englishQuestion).toBe(rawGujaratiQuestion);
        expect(capturedCtx.detectedLanguage).toBe("gujarati");
        expect(result).toBeDefined();
      } finally {
        chatService._resolveSession = originalResolveSession;
      }
    });
  });
});
