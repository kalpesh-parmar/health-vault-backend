const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const { ollamaClient } = require("../../src/clients/ollamaClient");
const aiClient = require("../../src/services/ai/clients/aiClient.service");
const { embeddingService } = require("../../src/services/ai/chat/embedding.service");
const { ragContextService } = require("../../src/services/ai/chat/ragContext.service");
const { db } = require("../../src/configs/db");
const { chatService } = require("../../src/services/ai/chat/chat.service");

jest.mock("../../src/repositories/chatSessionRepository");
jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/clients/ollamaClient");
jest.mock("../../src/services/ai/clients/aiClient.service");
jest.mock("../../src/services/ai/chat/embedding.service");
jest.mock("../../src/services/ai/chat/ragContext.service", () => {
  const actual = jest.requireActual("../../src/services/ai/chat/ragContext.service");
  return {
    ...actual,
    ragContextService: {
      retrieveRagContext: jest.fn(),
    },
    buildDependencyAwareContext: jest.fn().mockResolvedValue("=== PATIENT CONTEXT ==="),
  };
});
jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn(),
  },
}));

function mockDbSelect(result = []) {
  const chain = {
    from: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  db.select.mockReturnValue(chain);
  return chain;
}

describe("chatService Characterization Tests (Behavior Contracts)", () => {
  const mockUserId = "usr-contract-123";
  const mockSessionId = "sess-contract-456";

  beforeEach(() => {
    jest.clearAllMocks();

    patientRepository.findById.mockResolvedValue({
      id: mockUserId,
      firstName: "John",
      lastName: "Doe",
      preferredLanguage: "english",
      dateOfBirth: new Date("1990-01-15"),
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
      items: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });

    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: `msg-${Date.now()}-${Math.random()}`,
      ...msg,
    }));

    aiClient.detectLanguage.mockResolvedValue("english");
    aiClient.translate.mockImplementation(async (text) => text);
  });

  // 1. Age Intercept Path
  test("1. Age Intercept: returns expected shape and AI metadata", async () => {
    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "how old am i?",
    });

    expect(result).toHaveProperty("ai");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("mode", "GENERAL_HEALTH");
    expect(result).toHaveProperty("emergency", false);
    expect(result.citations).toEqual([]);

    expect(result.ai.metadata).toEqual({
      mode: "GENERAL_HEALTH",
      emergency: false,
      intercepted: true,
      documentId: [],
    });
    expect(typeof result.reply).toBe("string");
    expect(result.reply).toContain("36");
  });

  // 2. Summary Intercept Path
  test("2. Summary Intercept: returns expected shape with options, no citations", async () => {
    const mockDoc = {
      id: "doc-sum-1",
      fileName: "cbc_report.pdf",
      reportDate: new Date("2026-01-10"),
      ocrStatus: "COMPLETED",
      summaryEnglish: "Blood test normal with mild vitamin D deficiency.",
      structuredExtractedData: { patient: { name: "John Doe" } },
    };
    mockDbSelect([mockDoc]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "give me summary of my report",
    });

    expect(result).toHaveProperty("ai");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("mode", "DOCUMENT_RAG");
    expect(result).toHaveProperty("emergency", false);
    expect(result).toHaveProperty("options");
    expect(Array.isArray(result.options)).toBe(true);
    expect(result.citations).toEqual([]);

    expect(result.ai.metadata).toMatchObject({
      mode: "DOCUMENT_RAG",
      emergency: false,
      documentId: ["doc-sum-1"],
      task: "SUMMARY",
    });
  });

  // 3. Medication List Intercept Path
  test("3. Medication List Intercept: returns STRUCTURED_LIST with no citations key", async () => {
    medicationRepository.findAll.mockResolvedValue([
      {
        id: "med-1",
        medicationName: "Metformin",
        medicationType: "TABLET",
        dosePerIntake: "500",
        unit: "mg",
        frequency: "Twice daily",
        prescribedBy: "Dr. Adams",
      },
    ]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "list my medicines",
    });

    expect(result).toHaveProperty("ai");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("mode", "STRUCTURED_LIST");
    expect(result).toHaveProperty("emergency", false);
    expect(result).not.toHaveProperty("citations"); // CRITICAL: no citations key

    expect(typeof result.reply).toBe("object");
    expect(result.reply.items).toHaveLength(1);
    expect(result.reply.items[0].name).toBe("Metformin");
    expect(result.ai.metadata).toEqual({
      mode: "STRUCTURED_LIST",
      task: "MEDICATION_LIST",
      emergency: false,
      documentId: [],
    });
  });

  // 4. Document List Intercept Path
  test("4. Document List Intercept: returns STRUCTURED_LIST with no citations key", async () => {
    documentRepository.getSummaryByUserId.mockResolvedValue([
      {
        id: "doc-list-1",
        fileName: "xray.pdf",
        documentType: "radiology",
        fileType: "application/pdf",
        reportDate: new Date("2026-02-20"),
        ocrStatus: "COMPLETED",
        remarks: null,
      },
    ]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "list my documents",
    });

    expect(result).toHaveProperty("ai");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("mode", "STRUCTURED_LIST");
    expect(result).toHaveProperty("emergency", false);
    expect(result).not.toHaveProperty("citations"); // CRITICAL: no citations key

    expect(typeof result.reply).toBe("object");
    expect(result.reply.items).toHaveLength(1);
    expect(result.reply.items[0].fileName).toBe("xray.pdf");
    expect(result.ai.metadata).toEqual({
      mode: "STRUCTURED_LIST",
      task: "DOCUMENT_LIST",
      emergency: false,
      documentId: [],
    });
  });

  // 5. Require Selection Intercept Path
  test("5. Require Selection Intercept: returns requireSelection: true and reports", async () => {
    const mockReports = [
      { id: "doc-1", fileName: "blood1.pdf" },
      { id: "doc-2", fileName: "blood2.pdf" },
    ];
    mockDbSelect(mockReports);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "compare",
    });

    expect(result).toHaveProperty("ai");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("requireSelection", true);
    expect(result).toHaveProperty("reports", mockReports);
    expect(result).toHaveProperty("mode", "DOCUMENT_RAG");
    expect(result).toHaveProperty("emergency", false);

    expect(result.ai.metadata).toMatchObject({
      mode: "DOCUMENT_RAG",
      emergency: false,
      requireSelection: true,
      reports: mockReports,
      documentId: [],
    });
  });

  // 6. Main Flow - General Intent Path
  test("6A. Main Flow (GENERAL Intent): returns general health answer with empty citations", async () => {
    ollamaClient.chat.mockResolvedValue(
      "Drinking water and exercising helps maintain overall fitness.",
    );

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "how can i stay healthy and fit?",
    });

    expect(result).toHaveProperty("ai");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty(
      "reply",
      "Drinking water and exercising helps maintain overall fitness.",
    );
    expect(result).toHaveProperty("mode", "GENERAL_HEALTH");
    expect(result).toHaveProperty("emergency", false);
    expect(result.citations).toEqual([]);

    expect(result.ai.metadata).toEqual({
      mode: "GENERAL_HEALTH",
      emergency: false,
      documentId: [],
      task: "GENERAL",
    });
  });

  // 6. Main Flow - DOCUMENT_RAG Intent Path
  test("6B. Main Flow (DOCUMENT_RAG Intent): returns rag answer with citations and doc metadata", async () => {
    const mockDoc = { id: "doc-rag-1", fileName: "lipids.pdf" };
    // db.select will be called for recentDocs, and then for finalDocsMetadata
    mockDbSelect([mockDoc]);

    embeddingService.embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    ragContextService.retrieveRagContext.mockResolvedValue({
      summaryChunks: [
        {
          chunkId: "c1",
          documentId: "doc-rag-1",
          content: "Cholesterol level is 185 mg/dL.",
          docData: mockDoc,
        },
      ],
      coverageStr: "lipids.pdf: [CHOLESTEROL: FOUND]",
      relevantChunksCount: 1,
    });
    ollamaClient.chat.mockResolvedValue(
      "Your cholesterol level is 185 mg/dL, which is within the normal range.",
    );

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "what is my cholesterol level in the report?",
    });

    expect(result).toHaveProperty("ai");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty(
      "reply",
      "Your cholesterol level is 185 mg/dL, which is within the normal range.",
    );
    expect(result).toHaveProperty("mode", "DOCUMENT_RAG");
    expect(result).toHaveProperty("emergency", false);
    expect(result.citations).toEqual([]);

    expect(result.ai.metadata).toEqual({
      mode: "DOCUMENT_RAG",
      emergency: false,
      documentId: ["doc-rag-1"],
      task: "DOCUMENT",
    });
  });
});
