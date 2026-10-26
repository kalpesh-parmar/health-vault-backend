const { sendChatMessageSchema } = require("../../src/validations/documentFlowValidation");
const {
  documentAuthorizationService,
} = require("../../src/services/ai/chat/documentAuthorization.service");
const { slotContextService } = require("../../src/services/ai/chat/slotContext.service");
const { NotFoundException } = require("../../src/exceptions/appError");

describe("Milestone v8.3 Phase 1 - Inline @Document Mentions Contracts & Scope Integration", () => {
  describe("sendChatMessageSchema Mentions Validation", () => {
    it("validates a valid mentions array with documentId and displayName", () => {
      const payload = {
        question: "Summarize @Apollo Report",
        mentions: [
          {
            documentId: "d1111111-1111-1111-1111-111111111111",
            displayName: "Apollo Report",
            type: "DOCUMENT",
            fileName: "Apollo_Report.pdf",
          },
        ],
      };

      const result = sendChatMessageSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(result.data.mentions).toHaveLength(1);
      expect(result.data.mentions[0].documentId).toBe("d1111111-1111-1111-1111-111111111111");
      expect(result.data.mentions[0].type).toBe("DOCUMENT");
    });

    it("parses stringified JSON mentions array cleanly", () => {
      const payload = {
        question: "Compare @DocA and @DocB",
        mentions: JSON.stringify([
          { documentId: "doc-1", displayName: "DocA" },
          { documentId: "doc-2", displayName: "DocB" },
        ]),
      };

      const result = sendChatMessageSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(result.data.mentions).toHaveLength(2);
      expect(result.data.mentions[0].documentId).toBe("doc-1");
      expect(result.data.mentions[1].documentId).toBe("doc-2");
    });

    it("allows payload without mentions (optional and backward-compatible)", () => {
      const payload = {
        question: "What is my hemoglobin?",
        documentId: "d1111111-1111-1111-1111-111111111111",
      };

      const result = sendChatMessageSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(result.data.mentions).toBeUndefined();
      expect(result.data.documentId).toEqual(["d1111111-1111-1111-1111-111111111111"]);
    });

    it("rejects mentions that do not contain a valid documentId", () => {
      const payload = {
        question: "Invalid mention test",
        mentions: [{ displayName: "Missing ID" }],
      };

      const result = sendChatMessageSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("Document Authorization & Fail-Closed Guard with Mentions", () => {
    it("authorizes a single mentioned document ID and returns SINGLE_DOCUMENT scope candidates", async () => {
      const mockDocs = [
        { id: "doc-uuid-1", userId: "user-123", softDelete: false, fileName: "Report_A.pdf" },
      ];

      const dbSelectSpy = jest.spyOn(require("../../src/configs/db").db, "select").mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockDocs),
        }),
      });

      const mentions = [{ documentId: "doc-uuid-1", displayName: "Report A" }];
      const docIds = mentions.map((m) => m.documentId);

      const authRes = await documentAuthorizationService.authorizeDocumentIds("user-123", docIds);
      expect(authRes.authorizedDocumentIds).toEqual(["doc-uuid-1"]);
      expect(authRes.documents).toHaveLength(1);

      dbSelectSpy.mockRestore();
    });

    it("authorizes multiple mentioned document IDs and returns MULTI_DOCUMENT scope candidates", async () => {
      const mockDocs = [
        { id: "doc-uuid-1", userId: "user-123", softDelete: false, fileName: "Report_A.pdf" },
        { id: "doc-uuid-2", userId: "user-123", softDelete: false, fileName: "Report_B.pdf" },
      ];

      const dbSelectSpy = jest.spyOn(require("../../src/configs/db").db, "select").mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockDocs),
        }),
      });

      const mentions = [
        { documentId: "doc-uuid-1", displayName: "Report A" },
        { documentId: "doc-uuid-2", displayName: "Report B" },
      ];
      const docIds = mentions.map((m) => m.documentId);

      const authRes = await documentAuthorizationService.authorizeDocumentIds("user-123", docIds);
      expect(authRes.authorizedDocumentIds).toEqual(["doc-uuid-1", "doc-uuid-2"]);
      expect(authRes.documents).toHaveLength(2);

      dbSelectSpy.mockRestore();
    });

    it("fails closed when a mentioned document ID is unauthorized or soft-deleted", async () => {
      // User mentions doc-uuid-1 (owned) and doc-forged-999 (not in user's active docs)
      const mockDocs = [
        { id: "doc-uuid-1", userId: "user-123", softDelete: false, fileName: "Report_A.pdf" },
      ];

      const dbSelectSpy = jest.spyOn(require("../../src/configs/db").db, "select").mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockDocs),
        }),
      });

      const mentions = [
        { documentId: "doc-uuid-1", displayName: "Report A" },
        { documentId: "doc-forged-999", displayName: "Forged Report" },
      ];
      const docIds = mentions.map((m) => m.documentId);

      await expect(
        documentAuthorizationService.authorizeDocumentIds("user-123", docIds),
      ).rejects.toThrow(NotFoundException);

      dbSelectSpy.mockRestore();
    });
  });

  describe("SlotContextService Mention Scoping & Multi-Turn Retention", () => {
    it("assigns SINGLE_DOCUMENT scopeMode when 1 mention ID is provided", () => {
      const existingSlots = {};
      const mentions = [{ documentId: "doc-1", displayName: "Report 1" }];

      const updated = slotContextService.resolveTurnSlots(
        existingSlots,
        { medicalIntent: { intent: "DOCUMENT_SUMMARY" } },
        { language: "english" },
        ["doc-1"],
        { scopeMode: "SINGLE_DOCUMENT", mentions },
      );

      expect(updated.activeDocumentId).toBe("doc-1");
      expect(updated.activeDocumentIds).toEqual(["doc-1"]);
      expect(updated.scopeMode).toBe("SINGLE_DOCUMENT");
      expect(updated.activeMentions).toEqual(mentions);
    });

    it("assigns MULTI_DOCUMENT scopeMode when 2 or more mention IDs are provided", () => {
      const existingSlots = {};
      const mentions = [
        { documentId: "doc-1", displayName: "Report 1" },
        { documentId: "doc-2", displayName: "Report 2" },
      ];

      const updated = slotContextService.resolveTurnSlots(
        existingSlots,
        { medicalIntent: { intent: "DOCUMENT_COMPARISON" } },
        { language: "english" },
        ["doc-1", "doc-2"],
        { scopeMode: "MULTI_DOCUMENT", mentions },
      );

      expect(updated.activeDocumentId).toBe("doc-1");
      expect(updated.activeDocumentIds).toEqual(["doc-1", "doc-2"]);
      expect(updated.scopeMode).toBe("MULTI_DOCUMENT");
      expect(updated.activeMentions).toEqual(mentions);
    });

    it("retains previous document scope on a follow-up turn with 0 mentions", () => {
      const previousSlots = {
        activeDocumentId: "doc-1",
        activeDocumentIds: ["doc-1"],
        scopeMode: "SINGLE_DOCUMENT",
        activeMentions: [{ documentId: "doc-1", displayName: "Report 1" }],
        activeMetric: "hemoglobin",
      };

      // Turn 2: Follow-up question has no new documentIds or mentions
      const updated = slotContextService.resolveTurnSlots(
        previousSlots,
        { medicalIntent: { intent: "FACT_LOOKUP", canonicalMetric: "glucose_fasting" } },
        { language: "english" },
        [], // No new document IDs
        {},
      );

      // Must retain activeDocumentIds and scopeMode from previous turn
      expect(updated.activeDocumentId).toBe("doc-1");
      expect(updated.activeDocumentIds).toEqual(["doc-1"]);
      expect(updated.scopeMode).toBe("SINGLE_DOCUMENT");
      expect(updated.activeMetric).toBe("glucose_fasting");
    });

    it("replaces previous document scope when a new explicit mention is provided", () => {
      const previousSlots = {
        activeDocumentId: "doc-1",
        activeDocumentIds: ["doc-1"],
        scopeMode: "SINGLE_DOCUMENT",
        activeMentions: [{ documentId: "doc-1", displayName: "Report 1" }],
      };

      // Turn 2: User explicitly mentions a different report
      const newMentions = [{ documentId: "doc-2", displayName: "Report 2" }];
      const updated = slotContextService.resolveTurnSlots(
        previousSlots,
        { medicalIntent: { intent: "DOCUMENT_SUMMARY" } },
        { language: "gujarati" },
        ["doc-2"], // New document ID
        { scopeMode: "SINGLE_DOCUMENT", mentions: newMentions },
      );

      expect(updated.activeDocumentId).toBe("doc-2");
      expect(updated.activeDocumentIds).toEqual(["doc-2"]);
      expect(updated.scopeMode).toBe("SINGLE_DOCUMENT");
      expect(updated.activeMentions).toEqual(newMentions);
    });
  });
});
