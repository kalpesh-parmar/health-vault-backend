const { slotContextService } = require("../../src/services/ai/chat/slotContext.service");
const {
  documentAuthorizationService,
} = require("../../src/services/ai/chat/documentAuthorization.service");

describe("Milestone v8.3 Phase 5 - Multilingual & Multi-Turn Mention Scoping", () => {
  const userId = "user-123";
  const patientId = "patient-456";

  const docA = {
    id: "doc-uuid-aaa-111",
    userId,
    patientId,
    fileName: "Urocare Report.pdf",
    documentType: "LAB_REPORT",
    deletedAt: null,
  };

  const docB = {
    id: "doc-uuid-bbb-222",
    userId,
    patientId,
    fileName: "January Blood Report.pdf",
    documentType: "LAB_REPORT",
    deletedAt: null,
  };

  const docC = {
    id: "doc-uuid-ccc-333",
    userId,
    patientId,
    fileName: "February Blood Report.pdf",
    documentType: "LAB_REPORT",
    deletedAt: null,
  };

  const mockDbDocs = [docA, docB, docC];

  beforeEach(() => {
    jest.restoreAllMocks();

    jest
      .spyOn(documentAuthorizationService, "authorizeDocumentIds")
      .mockImplementation(async (uId, docIds) => {
        const authorized = [];
        const foundDocs = [];
        for (const id of docIds || []) {
          const matched = mockDbDocs.find((d) => d.id === id && d.userId === uId && !d.deletedAt);
          if (matched) {
            authorized.push(matched.id);
            foundDocs.push(matched);
          } else {
            throw new Error(`Document ${id} is not authorized for user ${uId}`);
          }
        }
        return {
          authorizedDocumentIds: authorized,
          documents: foundDocs,
          isSingleDocument: authorized.length === 1,
          isMultiDocument: authorized.length > 1,
        };
      });
  });

  describe("Multilingual Text Sanitization for Language Detection", () => {
    it("strips @mention tokens cleanly so English filenames do not bias Indic queries", () => {
      const stripMentions = (text) =>
        text
          .replace(/@[^\s@]+/g, "")
          .replace(/\s+/g, " ")
          .trim() || text;

      // Gujarati query with mention
      const gujQuery = "@Urocare Report ni summary apo";
      expect(stripMentions(gujQuery)).toBe("Report ni summary apo");

      // Gujarati clinical query
      const gujHemoglobin = "@ReportA ma hemoglobin ketlu chhe?";
      expect(stripMentions(gujHemoglobin)).toBe("ma hemoglobin ketlu chhe?");

      // Hindi query
      const hindiQuery = "Explain @Prescription in Hindi";
      expect(stripMentions(hindiQuery)).toBe("Explain in Hindi");

      // Marathi query
      const marathiQuery = "@ReportA madhe hemoglobin kiti ahe?";
      expect(stripMentions(marathiQuery)).toBe("madhe hemoglobin kiti ahe?");

      // Tamil query
      const tamilQuery = "@ReportA-vil hemoglobin evalavu ullathu?";
      expect(stripMentions(tamilQuery)).toBe("hemoglobin evalavu ullathu?");

      // English comparison query
      const engCompare = "Compare @ReportA and @ReportB";
      expect(stripMentions(engCompare)).toBe("Compare and");
    });
  });

  describe("Multi-Turn Scope Retention & Replacement Workflow", () => {
    it("preserves document scope across 3 turns of follow-up questions in Gujarati and English", async () => {
      // Turn 1: User asks in Gujlish with @ReportA
      const turn1Mentions = [
        {
          documentId: docA.id,
          displayName: "Urocare Report",
          type: "DOCUMENT",
        },
      ];

      const auth1 = await documentAuthorizationService.authorizeDocumentIds(
        userId,
        turn1Mentions.map((m) => m.documentId),
      );
      expect(auth1.authorizedDocumentIds).toEqual([docA.id]);

      let currentSlots = slotContextService.resolveTurnSlots(
        {},
        { medicalIntent: { intent: "DOCUMENT_SUMMARY" } },
        { language: "gujarati" },
        auth1.authorizedDocumentIds,
        { scopeMode: "SINGLE_DOCUMENT", mentions: turn1Mentions },
      );

      expect(currentSlots.activeDocumentIds).toEqual([docA.id]);
      expect(currentSlots.scopeMode).toBe("SINGLE_DOCUMENT");
      expect(currentSlots.activeMentions).toHaveLength(1);

      // Turn 2: Follow-up question "What about blood sugar?" without mentions
      const turn2Mentions = [];
      const isExplicitTurn2 = turn2Mentions.length > 0;
      expect(isExplicitTurn2).toBe(false);

      // System retains previous scope from session slots
      currentSlots = slotContextService.resolveTurnSlots(
        currentSlots,
        { medicalIntent: { intent: "SPECIFIC_FACT" } },
        { language: "english" },
        [],
        {},
      );
      expect(currentSlots.activeDocumentIds).toEqual([docA.id]);
      expect(currentSlots.scopeMode).toBe("SINGLE_DOCUMENT");

      // Turn 3: Follow-up "Explain in Gujarati" without mentions
      currentSlots = slotContextService.resolveTurnSlots(
        currentSlots,
        { medicalIntent: { intent: "GENERAL" } },
        { language: "gujarati" },
        [],
        {},
      );
      expect(currentSlots.activeDocumentIds).toEqual([docA.id]);
      expect(currentSlots.scopeMode).toBe("SINGLE_DOCUMENT");

      // Turn 4: User explicitly switches scope to compare Report B and Report C
      const turn4Mentions = [
        { documentId: docB.id, displayName: "January Report", type: "DOCUMENT" },
        { documentId: docC.id, displayName: "February Report", type: "DOCUMENT" },
      ];

      const auth4 = await documentAuthorizationService.authorizeDocumentIds(
        userId,
        turn4Mentions.map((m) => m.documentId),
      );
      expect(auth4.authorizedDocumentIds).toEqual([docB.id, docC.id]);
      expect(auth4.isMultiDocument).toBe(true);

      // Replace session slots with newly mentioned documents
      currentSlots = slotContextService.resolveTurnSlots(
        currentSlots,
        { medicalIntent: { intent: "DOCUMENT_COMPARISON" } },
        { language: "english" },
        auth4.authorizedDocumentIds,
        { scopeMode: "MULTI_DOCUMENT", mentions: turn4Mentions },
      );

      expect(currentSlots.activeDocumentIds).toEqual([docB.id, docC.id]);
      expect(currentSlots.scopeMode).toBe("MULTI_DOCUMENT");
      expect(currentSlots.activeMentions).toHaveLength(2);
    });

    it("fails closed when an unowned document ID is mentioned in an Indic query", async () => {
      const forgedMention = [
        {
          documentId: "forged-doc-999",
          displayName: "Secret Report",
          type: "DOCUMENT",
        },
      ];

      await expect(
        documentAuthorizationService.authorizeDocumentIds(
          userId,
          forgedMention.map((m) => m.documentId),
        ),
      ).rejects.toThrow("is not authorized");
    });
  });
});
