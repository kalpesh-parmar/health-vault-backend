const { ChatService } = require("../../src/services/ai/chat/chat.service");

// Mock dependencies
jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn(),
  },
}));

jest.mock("../../src/clients/ollamaClient", () => ({
  ollamaClient: {
    chat: jest.fn().mockResolvedValue("According to the report, your hemoglobin is 14.2 g/dL."),
  },
}));

describe("Phase 4 - Document Citations & Page Attribution Pipeline", () => {
  let chatService;

  beforeEach(() => {
    jest.clearAllMocks();
    chatService = new ChatService();
  });

  describe("qwenHealthChat citation extraction", () => {
    it("extracts genuine document citations from summaryChunks", async () => {
      const summaryChunks = [
        {
          documentId: "doc-A",
          fileName: "Blood_Test_Jan2025.pdf",
          pageNumber: 2,
          relevanceScore: 0.88,
          content: "Hemoglobin: 14.2 g/dL (Reference Range: 13.0 - 17.0)",
        },
        {
          documentId: "doc-A",
          fileName: "Blood_Test_Jan2025.pdf",
          pageNumber: 2, // duplicate doc and page
          relevanceScore: 0.81,
          content: "RBC Count: 4.8 million/mcL",
        },
        {
          documentId: "doc-B",
          fileName: "Lipid_Profile.pdf",
          pageNumber: 1,
          relevanceScore: 0.75,
          content: "Total Cholesterol: 195 mg/dL",
        },
      ];

      const res = await chatService.qwenHealthChat(
        [{ role: "user", content: "What is my hemoglobin?" }],
        "DOCUMENT_RAG",
        summaryChunks,
        "",
        "english",
      );

      expect(res.citations).toHaveLength(2); // doc-A p2, doc-B p1
      expect(res.citations[0].documentId).toBe("doc-A");
      expect(res.citations[0].pageNumber).toBe(2);
      expect(res.citations[0].relevanceScore).toBe(0.88);
      expect(res.citations[0].excerpt).toContain("Hemoglobin: 14.2");

      expect(res.citations[1].documentId).toBe("doc-B");
      expect(res.citations[1].pageNumber).toBe(1);
    });

    it("returns empty citations when no summaryChunks are provided (GENERAL mode)", async () => {
      const res = await chatService.qwenHealthChat(
        [{ role: "user", content: "How much water should I drink?" }],
        "GENERAL_HEALTH",
        [],
        "",
        "english",
      );

      expect(res.citations).toEqual([]);
    });

    it("defaults pageNumber to 1 if missing from chunk", async () => {
      const summaryChunks = [
        {
          documentId: "doc-C",
          relevanceScore: 0.92,
          content: "Blood Pressure: 120/80 mmHg",
        },
      ];

      const res = await chatService.qwenHealthChat(
        [{ role: "user", content: "What was my BP?" }],
        "DOCUMENT_RAG",
        summaryChunks,
        "",
        "english",
      );

      expect(res.citations).toHaveLength(1);
      expect(res.citations[0].documentId).toBe("doc-C");
      expect(res.citations[0].pageNumber).toBe(1);
    });
  });
});
