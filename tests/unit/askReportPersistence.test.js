const { onboardingService } = require("../../src/services/ai/chat/onboarding.service");
const { chatService } = require("../../src/services/ai/chat/chat.service");
const ocrService = require("../../src/services/ocr.service");

const documentIdentityService = require("../../src/services/documentIdentity.service");

// Mock dependencies
jest.mock("../../src/repositories/patientRepository", () => ({
  findById: jest.fn().mockResolvedValue({ id: "patient-1", firstName: "Test", lastName: "User" }),
  updateById: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/repositories/authProviderRepository", () => ({
  findByUserId: jest.fn().mockResolvedValue([{ provider: "email" }]),
}));

jest.mock("../../src/repositories/userOnboardingRepository", () => ({
  findByUserId: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  updateByUserId: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/repositories/chatSessionRepository", () => ({
  listMessages: jest.fn().mockResolvedValue({ items: [] }),
  appendMessage: jest.fn().mockResolvedValue({ id: "msg-1" }),
}));

jest.mock("../../src/services/documentIdentity.service", () => ({
  resolveCanonicalDocument: jest.fn().mockImplementation(({ documentIdOrFileKey }) =>
    Promise.resolve({
      id: documentIdOrFileKey,
      fileName: "Medical_Report.pdf",
      documentType: "LAB_REPORT",
      summary: "Report Summary Text",
    }),
  ),
}));

describe("ASK_REPORT Persistence & Dashboard Navigation Regression Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("1. ASK_REPORT Assistant Message Persistence", () => {
    test("persists assistant message with non-empty content and complete structured metadata even when response.message is empty", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({
        id: "msg-report-1",
        createdAt: new Date(),
      });

      const syntheticDoc = {
        id: "doc-uuid-123",
        fileName: "Blood_Test_Report.pdf",
        documentType: "LAB_REPORT",
        reportDate: "2026-03-15",
        hospitalName: "Apollo Hospital",
        doctorName: "Dr. Sharma",
        summary: "Hemoglobin is 13.5 g/dL (normal). Blood glucose fasting is 95 mg/dL (normal).",
        patientName: "John Doe",
        patientDetails: {
          name: "John Doe",
          age: 45,
          gender: "Male",
        },
        structuredExtractedData: {
          patientInfo: { name: "John Doe", fullName: "John Doe", age: 45, gender: "Male" },
        },
        abnormalResults: [],
        normalResults: [{ testName: "Hemoglobin", value: "13.5", unit: "g/dL", range: "12-16" }],
        isLabReport: true,
      };

      documentIdentityService.resolveCanonicalDocument.mockResolvedValueOnce(syntheticDoc);

      const state = {
        userId: "user-test-1",
        chatSessionId: "session-test-1",
        flowMode: "UPLOAD",
        currentStep: "ASK_REPORT",
        preferredLanguage: "english",
        documentId: "doc-uuid-123",
        documentUploaded: true,
        documentConfirmed: true,
        documentExtracted: true,
        documentOwnershipConfirmed: true,
        documentData: syntheticDoc,
        documentRecord: syntheticDoc,
        medicationFlowDone: true,
        medicinesConfirmed: true,
        isOnboardingCompleted: false,
      };

      const res = await onboardingService.chat(
        "ASK_REPORT",
        [],
        state,
        "user-test-1",
        "session-test-1",
        "My Report",
      );

      expect(res.action).toBe("ASK_REPORT");
      expect(res.document).toBeDefined();
      expect(res.document.id).toBe("doc-uuid-123");

      // Verify chatService.appendChatMessage was called for the assistant turn
      const assistantCalls = appendSpy.mock.calls.filter((c) => c[0].role === "assistant");
      expect(assistantCalls.length).toBe(1);

      const savedPayload = assistantCalls[0][0];
      expect(savedPayload.sessionId).toBe("session-test-1");
      expect(savedPayload.userId).toBe("user-test-1");
      expect(savedPayload.role).toBe("assistant");
      // Content must contain the displayable summary text
      expect(savedPayload.content).toBe(syntheticDoc.summary);
      expect(savedPayload.content.length).toBeGreaterThan(0);

      // Metadata must contain full structured document and action
      expect(savedPayload.metadata.action).toBe("ASK_REPORT");
      expect(savedPayload.metadata.document.id).toBe("doc-uuid-123");
      expect(savedPayload.metadata.document.patientDetails.name).toBe("John Doe");
      expect(savedPayload.metadata.preferredLanguage).toBe("english");
      expect(Array.isArray(savedPayload.metadata.suggestedQuestions)).toBe(true);
    });

    test("allows repeated legitimate report questions as separate chat turns", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({
        id: "msg-report-2",
        createdAt: new Date(),
      });

      const syntheticDoc = {
        id: "doc-repeat-456",
        fileName: "Lipid_Profile.pdf",
        documentType: "LAB_REPORT",
        summary: "Cholesterol is slightly elevated at 210 mg/dL.",
        patientDetails: { name: "Jane Smith" },
      };

      documentIdentityService.resolveCanonicalDocument.mockResolvedValue(syntheticDoc);

      const state = {
        userId: "user-repeat-1",
        chatSessionId: "session-repeat-1",
        flowMode: "UPLOAD",
        currentStep: "ASK_REPORT",
        preferredLanguage: "english",
        documentId: "doc-repeat-456",
        documentUploaded: true,
        documentConfirmed: true,
        documentExtracted: true,
        documentOwnershipConfirmed: true,
        documentData: syntheticDoc,
        documentRecord: syntheticDoc,
        medicationFlowDone: true,
        medicinesConfirmed: true,
      };

      // Turn 1: Initial ASK_REPORT
      await onboardingService.chat("ASK_REPORT", [], state, "user-repeat-1", "session-repeat-1");

      // Turn 2: User repeats or asks about report again
      await onboardingService.chat("ASK_REPORT", [], state, "user-repeat-1", "session-repeat-1");

      const assistantCalls = appendSpy.mock.calls.filter((c) => c[0].role === "assistant");
      // Both legitimate turns must have persisted assistant messages
      expect(assistantCalls.length).toBe(2);
      expect(assistantCalls[0][0].metadata.document.id).toBe("doc-repeat-456");
      expect(assistantCalls[1][0].metadata.document.id).toBe("doc-repeat-456");
    });
  });

  describe("2. Multilingual Summaries Persistence", () => {
    const languages = [
      { code: "gu", name: "gujarati", sample: "આ અહેવાલમાં હિમોગ્લોબિન સામાન્ય સ્તરે છે." },
      { code: "hi", name: "hindi", sample: "इस रिपोर्ट में हीमोग्लोबिन का स्तर सामान्य है।" },
      { code: "mr", name: "marathi", sample: "या अहवालात हिमोग्लोबिनची पातळी सामान्य आहे." },
      { code: "ta", name: "tamil", sample: "இந்த அறிக்கையில் ஹீமோகுளோபின் அளவு இயல்பாக உள்ளது." },
    ];

    test.each(languages)(
      "correctly stores and preserves summary in $name ($code)",
      async ({ code, name, sample }) => {
        const appendSpy = jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({
          id: `msg-${code}`,
          createdAt: new Date(),
        });

        const doc = {
          id: `doc-${code}-789`,
          fileName: `Report_${code}.pdf`,
          documentType: "LAB_REPORT",
          summary: sample,
          patientDetails: { name: "Patient" },
        };

        documentIdentityService.resolveCanonicalDocument.mockResolvedValue(doc);

        const state = {
          userId: `user-${code}`,
          chatSessionId: `session-${code}`,
          flowMode: "UPLOAD",
          currentStep: "ASK_REPORT",
          preferredLanguage: code,
          documentId: doc.id,
          documentUploaded: true,
          documentConfirmed: true,
          documentExtracted: true,
          documentOwnershipConfirmed: true,
          documentData: doc,
          documentRecord: doc,
          medicationFlowDone: true,
          medicinesConfirmed: true,
        };

        await onboardingService.chat("ASK_REPORT", [], state, `user-${code}`, `session-${code}`);

        const assistantCalls = appendSpy.mock.calls.filter((c) => c[0].role === "assistant");
        expect(assistantCalls.length).toBe(1);

        const savedPayload = assistantCalls[0][0];
        expect(savedPayload.content).toBe(sample);
        expect(savedPayload.metadata.document.summary).toBe(sample);
        expect([code, name]).toContain(savedPayload.metadata.preferredLanguage);
      },
    );
  });

  describe("3. DASHBOARD Navigation Action Persistence Isolation", () => {
    test("persists exactly one explicit user selection message and zero synthetic assistant messages when DASHBOARD is received in MANUAL flow", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage");
      appendSpy.mockClear();

      const state = {
        userId: "user-dash-manual",
        chatSessionId: "session-dash-manual",
        flowMode: "MANUAL",
        currentStep: "MEDICINE_OPTIONS",
        preferredLanguage: "english",
        medicationFlowDone: false,
        medicinesConfirmed: false,
      };

      const res = await onboardingService.chat(
        "DASHBOARD",
        [],
        state,
        "user-dash-manual",
        "session-dash-manual",
        "Go to Dashboard",
      );

      expect(res.state.isOnboardingCompleted).toBe(true);
      expect(res.state.currentStep).toBe("COMPLETE");

      // Verify exactly one explicit user message was appended and zero assistant messages
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          content: "Go to Dashboard",
          metadata: expect.objectContaining({
            selectedOption: "DASHBOARD",
          }),
        }),
      );
    });

    test("persists exactly one explicit user selection message when GO_TO_DASHBOARD alias is received in UPLOAD flow", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage");
      appendSpy.mockClear();

      const state = {
        userId: "user-dash-upload",
        chatSessionId: "session-dash-upload",
        flowMode: "UPLOAD",
        currentStep: "MEDICINE_OPTIONS",
        preferredLanguage: "english",
        medicationFlowDone: false,
        medicinesConfirmed: false,
      };

      const res = await onboardingService.chat(
        "GO_TO_DASHBOARD",
        [],
        state,
        "user-dash-upload",
        "session-dash-upload",
        "Go to Dashboard",
      );

      expect(res.state.isOnboardingCompleted).toBe(true);
      expect(res.state.currentStep).toBe("POST_ONBOARDING");
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          content: "Go to Dashboard",
          metadata: expect.objectContaining({
            selectedOption: "DASHBOARD",
          }),
        }),
      );
    });
  });

  describe("4. Chat History Hydration Logic Verification", () => {
    function mapHistoryMessage(dbMsg) {
      const meta =
        typeof dbMsg.metadata === "string" ? JSON.parse(dbMsg.metadata) : dbMsg.metadata || {};
      const msgAction =
        meta.action || meta.actionType || (dbMsg.role === "assistant" ? "NORMAL_CHAT" : undefined);
      const isAskReport =
        msgAction === "ASK_REPORT" ||
        meta.action === "ASK_REPORT" ||
        meta.actionType === "ASK_REPORT";

      const hasStructuredDoc = Boolean(
        meta?.document &&
        (meta.document.patientDetails ||
          meta.document.isLabReport ||
          (Array.isArray(meta.document.abnormalResults) &&
            meta.document.abnormalResults.length > 0) ||
          (Array.isArray(meta.document.normalResults) && meta.document.normalResults.length > 0) ||
          meta.document.summary),
      );

      let text = dbMsg.content || "";
      if (isAskReport && hasStructuredDoc && dbMsg.role === "assistant") {
        text = "";
      }

      return {
        id: dbMsg.id,
        role: dbMsg.role === "assistant" ? "ai" : "user",
        text,
        action: msgAction,
        document: meta.document || null,
        documentSummary: meta.document?.summary || meta.documentSummary || null,
        reportSummary: meta.document?.summary || meta.reportSummary || null,
        suggestedQuestions: meta.suggestedQuestions || [],
        preferredLanguage: meta.preferredLanguage || meta.document?.preferredLanguage || undefined,
      };
    }

    test("hydrates structured report with empty text to suppress duplicate speech bubble while preserving document", () => {
      const dbRow = {
        id: "msg-hyd-1",
        role: "assistant",
        content: "Blood glucose is normal at 90 mg/dL.",
        metadata: {
          action: "ASK_REPORT",
          document: {
            id: "doc-1",
            summary: "Blood glucose is normal at 90 mg/dL.",
            isLabReport: true,
            patientDetails: { name: "Alice" },
          },
          suggestedQuestions: ["What does this mean?"],
          preferredLanguage: "english",
        },
      };

      const mapped = mapHistoryMessage(dbRow);
      // text must be empty so MessageBubble is not rendered above StructuredReportSummaryCard
      expect(mapped.text).toBe("");
      expect(mapped.action).toBe("ASK_REPORT");
      expect(mapped.document).toBeDefined();
      expect(mapped.document.id).toBe("doc-1");
      expect(mapped.reportSummary).toBe("Blood glucose is normal at 90 mg/dL.");
      expect(mapped.suggestedQuestions).toEqual(["What does this mean?"]);
    });

    test("preserves fallback text for older messages with missing or incomplete document metadata", () => {
      const legacyDbRow = {
        id: "msg-legacy-1",
        role: "assistant",
        content: "Legacy medical summary text without structured document metadata.",
        metadata: {
          action: "ASK_REPORT",
          document: null,
        },
      };

      const mapped = mapHistoryMessage(legacyDbRow);
      // Older messages without structured document must keep dbMsg.content as fallback text
      expect(mapped.text).toBe("Legacy medical summary text without structured document metadata.");
      expect(mapped.action).toBe("ASK_REPORT");
      expect(mapped.document).toBeNull();
    });
  });

  describe("5. Suggested Questions on ASK_REPORT Card Routing", () => {
    test("routes suggested report question to chatService.sendMessage and returns clinical response with navigation options", async () => {
      const sendSpy = jest.spyOn(chatService, "sendMessage").mockResolvedValueOnce({
        reply: "આ દસ્તાવેજ દર્શાવે છે કે દર્દીને નેફ્રોટિક સિન્ડ્રોમ છે.",
        options: [],
      });

      const body = {
        sessionId: "sess-test-report-q",
        message: "આ દસ્તાવેજનો અર્થ શું છે?",
        documentId: ["doc-uuid-123"],
        preferredLanguage: "gujarati",
        state: {
          chatSessionId: "sess-test-report-q",
          currentStep: "ASK_REPORT",
          isOnboardingCompleted: false,
          documentId: "doc-uuid-123",
          preferredLanguage: "gujarati",
          medicationFlowDone: true,
          medicinesConfirmed: true,
          medicinesSavedToDb: true,
          bloodGroupSkipped: false,
          allergiesSkipped: true,
        },
      };

      const result = await ocrService.onboardingChat("patient-1", body);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "patient-1",
          question: "આ દસ્તાવેજનો અર્થ શું છે?",
          documentId: ["doc-uuid-123"],
          preferredLanguage: "gujarati",
        }),
      );

      expect(result.mode).toBe("NORMAL_CHAT");
      expect(result.actionType).toBe("NORMAL_CHAT");
      expect(result.reply).toBe("આ દસ્તાવેજ દર્શાવે છે કે દર્દીને નેફ્રોટિક સિન્ડ્રોમ છે.");
      expect(result.onboardingState.currentStep).toBe("ASK_REPORT");
      expect(result.onboardingState.canSkip).toBe(true);
      expect(result.options).toEqual([]);
    });
  });

  describe("6. ASK_REPORT Button Selection Routing Isolation", () => {
    test("routes ASK_REPORT action to state machine and returns report summary card instead of RAG QA", async () => {
      const sendSpy = jest.spyOn(chatService, "sendMessage");

      const syntheticDoc = {
        id: "doc-uuid-card-1",
        fileName: "Blood_Test_Report.pdf",
        documentType: "LAB_REPORT",
        reportDate: "2026-03-15",
        hospitalName: "Apollo Hospital",
        doctorName: "Dr. Sharma",
        summary: "Hemoglobin is 13.5 g/dL (normal). Blood glucose fasting is 95 mg/dL (normal).",
        patientName: "John Doe",
        structuredExtractedData: {
          patientInfo: { name: "John Doe", fullName: "John Doe", age: 45, gender: "Male" },
        },
        abnormalResults: [],
        normalResults: [{ testName: "Hemoglobin", value: "13.5", unit: "g/dL", range: "12-16" }],
      };

      documentIdentityService.resolveCanonicalDocument.mockResolvedValue(syntheticDoc);

      const body = {
        sessionId: "sess-ask-report-btn",
        message: "ASK_REPORT",
        actionType: "ASK_REPORT",
        displayLabel: "Ask About My Report",
        documentId: ["doc-uuid-card-1"],
        preferredLanguage: "english",
        state: {
          userId: "patient-1",
          chatSessionId: "sess-ask-report-btn",
          currentStep: "MEDICINE_OPTIONS",
          documentId: "doc-uuid-card-1",
          documentRecord: syntheticDoc,
          documentData: syntheticDoc,
          preferredLanguage: "english",
          medicationFlowDone: true,
          medicinesConfirmed: true,
          medicinesSavedToDb: true,
        },
      };

      const result = await ocrService.onboardingChat("patient-1", body);

      // Must NOT route to RAG sendMessage for ASK_REPORT button selection
      expect(sendSpy).not.toHaveBeenCalled();

      // Must return ASK_REPORT action and summary card document payload
      expect(result.action).toBe("ASK_REPORT");
      expect(result.actionType).toBe("ASK_REPORT");
      expect(result.document).toBeDefined();
      expect(result.document.id).toBe("doc-uuid-card-1");
      expect(result.reportSummary).toBe(syntheticDoc.summary);
      expect(Array.isArray(result.suggestedQuestions)).toBe(true);
    });
  });
});
