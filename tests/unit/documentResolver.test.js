const { documentResolverService } = require("../../src/services/ai/chat/documentResolver.service");
const { slotContextService } = require("../../src/services/ai/chat/slotContext.service");

// Mock drizzle db
jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn(),
  },
}));

const { db } = require("../../src/configs/db");

describe("Phase 3 - Document Resolver & Context Persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("documentResolverService.isExplicitHistoricalQuery", () => {
    it("detects English historical queries", () => {
      expect(
        documentResolverService.isExplicitHistoricalQuery("Show trend across all my reports"),
      ).toBe(true);
      expect(
        documentResolverService.isExplicitHistoricalQuery(
          "What is my lifetime history of cholesterol?",
        ),
      ).toBe(true);
      expect(documentResolverService.isExplicitHistoricalQuery("In all my tests over time")).toBe(
        true,
      );
    });

    it("detects Gujarati historical queries", () => {
      expect(documentResolverService.isExplicitHistoricalQuery("મારા બધા રિપોર્ટ માં શુ છે?")).toBe(
        true,
      );
      expect(
        documentResolverService.isExplicitHistoricalQuery("તમામ રિપોર્ટ નો ઇતિહાસ બતાવો"),
      ).toBe(true);
    });

    it("detects Hindi historical queries", () => {
      expect(
        documentResolverService.isExplicitHistoricalQuery(
          "सारे रिपोर्ट में मेरा हीमोग्लोबिन क्या था?",
        ),
      ).toBe(true);
      expect(documentResolverService.isExplicitHistoricalQuery("सभी टेस्ट का रिकॉर्ड दिखाओ")).toBe(
        true,
      );
    });

    it("returns false for document-specific queries", () => {
      expect(
        documentResolverService.isExplicitHistoricalQuery("What is my glucose in this report?"),
      ).toBe(false);
      expect(
        documentResolverService.isExplicitHistoricalQuery(
          "Summarize the Apollo report from yesterday",
        ),
      ).toBe(false);
    });
  });

  describe("documentResolverService.isComparisonQuery", () => {
    it("detects English comparison queries", () => {
      expect(
        documentResolverService.isComparisonQuery("Compare this report with my previous report"),
      ).toBe(true);
      expect(documentResolverService.isComparisonQuery("How has it changed since last time?")).toBe(
        true,
      );
    });

    it("detects Gujarati and Hindi comparison queries", () => {
      expect(documentResolverService.isComparisonQuery("અગાઉના રિપોર્ટ સાથે સરખામણી કરો")).toBe(
        true,
      );
      expect(documentResolverService.isComparisonQuery("पिछली रिपोर्ट से तुलना करके बताओ")).toBe(
        true,
      );
    });

    it("returns false for non-comparison queries", () => {
      expect(documentResolverService.isComparisonQuery("What are the findings?")).toBe(false);
    });
  });

  describe("documentResolverService.resolvePredecessorDocument", () => {
    it("finds the immediate predecessor report of same documentType", async () => {
      const mockCurrentDoc = {
        id: "doc-2025",
        userId: "user-1",
        documentType: "LAB_REPORT",
        reportDate: new Date("2025-06-01"),
        createdAt: new Date("2025-06-01"),
      };
      const mockPredecessor = {
        id: "doc-2024",
        userId: "user-1",
        documentType: "LAB_REPORT",
        reportDate: new Date("2024-12-15"),
        createdAt: new Date("2024-12-15"),
      };

      // 1. Current doc lookup
      const mockLimitCurrent = jest.fn().mockResolvedValue([mockCurrentDoc]);
      const mockWhereCurrent = jest.fn().mockReturnValue({ limit: mockLimitCurrent });
      const mockFromCurrent = jest.fn().mockReturnValue({ where: mockWhereCurrent });

      // 2. Predecessor lookup
      const mockLimitPred = jest.fn().mockResolvedValue([mockPredecessor]);
      const mockOrderByPred = jest.fn().mockReturnValue({ limit: mockLimitPred });
      const mockWherePred = jest.fn().mockReturnValue({ orderBy: mockOrderByPred });
      const mockFromPred = jest.fn().mockReturnValue({ where: mockWherePred });

      db.select
        .mockReturnValueOnce({ from: mockFromCurrent })
        .mockReturnValueOnce({ from: mockFromPred });

      const predecessor = await documentResolverService.resolvePredecessorDocument(
        "user-1",
        "doc-2025",
      );
      expect(predecessor).not.toBeNull();
      expect(predecessor.id).toBe("doc-2024");
    });
  });

  describe("documentResolverService.resolveNaturalLanguageScope", () => {
    it("resolves exact single document matching hospital name and date", async () => {
      const mockDocs = [
        {
          id: "doc-urocare-2025",
          userId: "user-1",
          fileName: "Blood_Test_Urocare.pdf",
          hospitalName: "Urocare Hospital",
          doctorName: "Dr. Patel",
          reportDate: new Date("2025-01-15"),
          documentType: "LAB_REPORT",
          softDelete: false,
        },
        {
          id: "doc-sterling-2024",
          userId: "user-1",
          fileName: "Prescription.pdf",
          hospitalName: "Sterling Hospital",
          doctorName: "Dr. Shah",
          reportDate: new Date("2024-05-10"),
          documentType: "PRESCRIPTION",
          softDelete: false,
        },
      ];

      const mockLimit = jest.fn().mockResolvedValue(mockDocs);
      const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
      const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
      db.select.mockReturnValue({ from: mockFrom });

      const result = await documentResolverService.resolveNaturalLanguageScope(
        "user-1",
        "What does the January 2025 report from Urocare say?",
      );

      expect(result.resolved).toBe(true);
      expect(result.scopeMode).toBe("SINGLE_DOCUMENT");
      expect(result.documentIds).toEqual(["doc-urocare-2025"]);
      expect(result.matchedDoc.id).toBe("doc-urocare-2025");
    });

    it("triggers REQUIRE_DOCUMENT_SELECTION when multiple documents match equally", async () => {
      const mockDocs = [
        {
          id: "doc-urocare-1",
          userId: "user-1",
          fileName: "Report_1.pdf",
          hospitalName: "Urocare Hospital",
          doctorName: "Dr. Patel",
          reportDate: new Date("2025-01-10"),
          documentType: "LAB_REPORT",
          softDelete: false,
        },
        {
          id: "doc-urocare-2",
          userId: "user-1",
          fileName: "Report_2.pdf",
          hospitalName: "Urocare Hospital",
          doctorName: "Dr. Patel",
          reportDate: new Date("2025-01-10"),
          documentType: "LAB_REPORT",
          softDelete: false,
        },
      ];

      const mockLimit = jest.fn().mockResolvedValue(mockDocs);
      const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
      const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
      db.select.mockReturnValue({ from: mockFrom });

      const result = await documentResolverService.resolveNaturalLanguageScope(
        "user-1",
        "What did Dr. Patel say at Urocare?",
      );

      expect(result.resolved).toBe(false);
      expect(result.scopeMode).toBe("REQUIRE_DOCUMENT_SELECTION");
      expect(result.promptClarification).toBe(true);
      expect(result.candidateDocuments).toHaveLength(2);
    });
  });

  describe("slotContextService multi-turn carryover", () => {
    it("preserves active document and scopeMode across multi-turn language shifts", () => {
      // Turn 1: English - user opens Report A
      const turn1Slots = slotContextService.resolveTurnSlots(
        {},
        { intent: "DOCUMENT_SUMMARY" },
        { language: "english" },
        ["doc-A"],
        { scopeMode: "SINGLE_DOCUMENT" },
      );

      expect(turn1Slots.activeDocumentId).toBe("doc-A");
      expect(turn1Slots.scopeMode).toBe("SINGLE_DOCUMENT");

      // Turn 2: Follow-up question without re-sending documentId
      const turn2Slots = slotContextService.resolveTurnSlots(
        turn1Slots,
        { intent: "LAB_FACT", canonicalMetric: "hemoglobin" },
        { language: "english" },
        [], // No documentId sent by client on follow-up
      );

      expect(turn2Slots.activeDocumentId).toBe("doc-A");
      expect(turn2Slots.scopeMode).toBe("SINGLE_DOCUMENT");
      expect(turn2Slots.activeMetric).toBe("hemoglobin");

      // Turn 3: Language shift to Gujarati
      const turn3Slots = slotContextService.resolveTurnSlots(
        turn2Slots,
        { intent: "GENERAL" },
        { language: "gujarati" },
        [],
      );

      expect(turn3Slots.activeDocumentId).toBe("doc-A");
      expect(turn3Slots.scopeMode).toBe("SINGLE_DOCUMENT");
      expect(turn3Slots.lastLanguage).toBe("gujarati");
    });

    it("resets active documents when scope is explicitly cleared", () => {
      const activeSlots = {
        activeDocumentId: "doc-A",
        activeDocumentIds: ["doc-A"],
        scopeMode: "SINGLE_DOCUMENT",
      };

      const clearedSlots = slotContextService.resolveTurnSlots(activeSlots, {}, {}, [], {
        actionType: "CLEAR_DOCUMENT_SCOPE",
      });

      expect(clearedSlots.activeDocumentId).toBeNull();
      expect(clearedSlots.activeDocumentIds).toEqual([]);
      expect(clearedSlots.scopeMode).toBe("AUTHORIZED_HISTORY");
    });
  });
});
