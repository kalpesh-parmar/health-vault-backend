const {
  normalizeUnifiedChatInput,
  buildUnifiedResponse,
  detectActionIntent,
  executeAddDocumentAction,
} = require("../src/helpers/unifiedChat.helper");
const { normalizeCreateMedicationInput } = require("../src/helpers/medicineNormalize.helper");

describe("UnifiedChat Helper & Intent Unit Tests", () => {
  test("normalizeUnifiedChatInput should fallback question to message", () => {
    const input = {
      question: "How do I add a report?",
      actionType: "add_document",
    };
    const normalized = normalizeUnifiedChatInput(input);

    expect(normalized.message).toBe("How do I add a report?");
    expect(normalized.actionType).toBe("ADD_DOCUMENT");
  });

  test("detectActionIntent should detect document upload intent", () => {
    const text = "I want to upload document report";
    const result = detectActionIntent(text, "english");

    expect(result.suggestedAction).toBe("ADD_DOCUMENT");
    expect(result.options).toHaveLength(1);
    expect(result.options[0].actionType).toBe("ADD_DOCUMENT");
  });

  test("detectActionIntent should detect medicine creation intent", () => {
    const text = "Please add a new medicine Paracetamol";
    const result = detectActionIntent(text, "english");

    expect(result.suggestedAction).toBe("ADD_MEDICINE");
    expect(result.options).toHaveLength(1);
    expect(result.options[0].actionType).toBe("ADD_MEDICINE");
  });

  test("buildUnifiedResponse should format structured output object", () => {
    const payload = buildUnifiedResponse({
      mode: "ACTION",
      actionType: "ADD_MEDICINE",
      reply: "Medicine added",
      sessionId: "session-123",
    });

    expect(payload.mode).toBe("ACTION");
    expect(payload.actionType).toBe("ADD_MEDICINE");
    expect(payload.reply).toBe("Medicine added");
    expect(payload.sessionId).toBe("session-123");
  });

  test("normalizeCreateMedicationInput should map shorthand fields to createMedicationSchema shape", () => {
    const shorthand = {
      name: "Amoxicillin 500mg",
      type: "CAPSULE",
      dose: { count: 1 },
      frequency: "THRICE",
      foodFrequency: "AFTER_FOOD",
      startDate: "2026-08-12",
    };

    const normalized = normalizeCreateMedicationInput(shorthand);

    expect(normalized.medicationName).toBe("Amoxicillin 500mg");
    expect(normalized.medicationType).toBe("CAPSULE");
    expect(normalized.dosePerIntake).toBe(1);
    expect(normalized.frequency).toBe("Three Times Daily");
    expect(normalized.medicationSchedule.Morning).toBe("09:00:00");
    expect(normalized.totalQuantity).toBe(30);
  });

  test("executeAddDocumentAction should enqueue background OCR job when rawOcrData is missing", async () => {
    const mockDocumentOcrJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: "job-999", status: "QUEUED" }),
    };
    const mockDocumentPersistenceService = {
      addDocument: jest.fn(),
    };
    const mockChatService = {
      createSession: jest.fn(),
    };
    const mockChatSessionRepository = {
      appendMessage: jest.fn(),
    };

    const response = await executeAddDocumentAction({
      userId: "user-123",
      actionData: { s3Key: "documents/test_report.pdf", fileName: "test_report.pdf" },
      sessionId: "session-123",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    expect(mockDocumentOcrJobService.enqueue).toHaveBeenCalledWith({
      fileKey: "documents/test_report.pdf",
      mimeType: "application/pdf",
      userId: "user-123",
    });
    expect(response.mode).toBe("ACTION");
    expect(response.actionType).toBe("ADD_DOCUMENT");
    expect(response.document.ocrStatus).toBe("in_progress");
  });

  test("executeAddDocumentAction should return existing completed status without re-enqueueing", async () => {
    const mockDocumentOcrJobService = {
      enqueue: jest.fn(),
      getStatus: jest.fn().mockResolvedValue({ id: "job-888", status: "COMPLETED" }),
    };
    const mockDocumentPersistenceService = {
      addDocument: jest.fn(),
    };
    const mockChatService = {
      createSession: jest.fn(),
    };
    const mockChatSessionRepository = {
      appendMessage: jest.fn(),
    };

    const response = await executeAddDocumentAction({
      userId: "user-123",
      actionData: { s3Key: "documents/existing_report.pdf", fileName: "existing_report.pdf" },
      sessionId: "session-123",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    expect(mockDocumentOcrJobService.enqueue).not.toHaveBeenCalled();
    expect(response.mode).toBe("ACTION");
    expect(response.document.ocrStatus).toBe("completed");
    expect(response.reply).toContain("already been processed");
  });

  test("onboardingService should mark isOnboardingCompleted = true upon reaching MEDICINE_OPTIONS step", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    // Simulate state where basic profile info is provided
    const state = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      profileConfirmed: true,
      existingUserData: {
        firstName: "John",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
        bloodGroup: "O+",
        allergies: ["None"],
      },
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      medicationFlowDone: false,
    };

    const res = await onboardingService.chat("", [], state, null, null, null);

    expect(res.state.isOnboardingCompleted).toBe(true);
    expect(res.action).toBe("MEDICINE_OPTIONS");
  });

  test("onboardingService should maintain isOnboardingCompleted = true when user clicks ADD on MEDICINE_OPTIONS", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      profileConfirmed: true,
      existingUserData: {
        firstName: "John",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      medicationFlowDone: false,
      currentStep: "MEDICINE_OPTIONS",
      isOnboardingCompleted: true,
    };

    const res = await onboardingService.chat("ADD", [], state, null, null, null);

    expect(res.state.isOnboardingCompleted).toBe(true);
    expect(res.state.currentStep).toBe("ADD_MEDICINE");
  });
});
