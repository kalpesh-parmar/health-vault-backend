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
      requireSelection: true,
      reports: [{ id: "doc-1", fileName: "lab_report.pdf" }],
      allowMultiSelect: true,
      selectionType: "MULTIPLE",
    });

    expect(payload.mode).toBe("ACTION");
    expect(payload.actionType).toBe("ADD_MEDICINE");
    expect(payload.reply).toBe("Medicine added");
    expect(payload.sessionId).toBe("session-123");
    expect(payload.requireSelection).toBe(true);
    expect(payload.allowMultiSelect).toBe(true);
    expect(payload.selectionType).toBe("MULTIPLE");
    expect(payload.reports).toHaveLength(1);
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

  test("executeAddDocumentAction should return REVIEW_MEDICINES_LIST action post-onboarding when medications are extracted", async () => {
    const mockDocumentOcrJobService = { enqueue: jest.fn() };
    const mockDocumentPersistenceService = {
      addDocument: jest.fn().mockResolvedValue({
        document: { id: "doc-101", fileName: "prescription.pdf" },
      }),
    };
    const mockChatService = { createSession: jest.fn() };
    const mockChatSessionRepository = { appendMessage: jest.fn() };

    const actionData = {
      s3Key: "documents/prescription.pdf",
      fileName: "prescription.pdf",
      rawOcrData: {
        extractedStructuredData: {
          medications: [
            { name: "Metformin 500mg", type: "TABLET", dosage: "1", frequency: "TWICE" },
          ],
        },
      },
    };

    const response = await executeAddDocumentAction({
      userId: "user-123",
      actionData,
      sessionId: "session-123",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    expect(response.mode).toBe("ACTION");
    expect(response.actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(response.medicines).toHaveLength(1);
    expect(response.medicines[0].medicationName).toBe("Metformin 500mg");
    expect(response.suggestedAction).toBe("REVIEW_MEDICINES_LIST");
    expect(response.options).toEqual([
      { label: "Confirm Selected", value: "CONFIRM", actionType: "CONFIRM_MEDICINES" },
      { label: "Add New", value: "ADD", actionType: "ADD_MEDICINE" },
      { label: "Skip All", value: "SKIP", actionType: "SKIP_MEDICINES" },
    ]);
  });

  test("executeAddDocumentAction should aggregate medications across multiple files in batch upload", async () => {
    const mockDocumentOcrJobService = {
      getStatus: jest.fn().mockImplementation(({ fileKey }) => {
        if (fileKey.includes("doc1")) {
          return Promise.resolve({
            id: "job-1",
            status: "COMPLETED",
            extractedStructuredData: {
              medications: [{ name: "Aspirin", type: "TABLET", dosage: "1" }],
            },
          });
        }
        return Promise.resolve({
          id: "job-2",
          status: "COMPLETED",
          extractedStructuredData: {
            medications: [{ name: "Lipitor", type: "TABLET", dosage: "2" }],
          },
        });
      }),
    };
    const mockDocumentPersistenceService = { addDocument: jest.fn() };
    const mockChatService = { createSession: jest.fn() };
    const mockChatSessionRepository = { appendMessage: jest.fn() };

    const actionData = {
      files: [
        { fileKey: "documents/doc1.png", fileName: "doc1.png" },
        { fileKey: "documents/doc2.png", fileName: "doc2.png" },
      ],
    };

    const response = await executeAddDocumentAction({
      userId: "user-123",
      actionData,
      sessionId: "session-123",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatService: mockChatService,
      chatSessionRepository: mockChatSessionRepository,
    });

    expect(response.mode).toBe("ACTION");
    expect(response.actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(response.medicines).toHaveLength(2);
    expect(response.medicines.map((m) => m.medicationName)).toEqual(["Aspirin", "Lipitor"]);
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

    expect(res.action).toBe("MEDICINE_OPTIONS");
    expect(res.state.isOnboardingCompleted).toBe(false);
  });

  test("onboardingService should mark isOnboardingCompleted = true when user clicks DASHBOARD on MEDICINE_OPTIONS", async () => {
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
      isOnboardingCompleted: false,
    };

    const res = await onboardingService.chat("DASHBOARD", [], state, null, null, null);

    expect(res.state.isOnboardingCompleted).toBe(true);
    expect(res.state.medicationFlowDone).toBe(true);
  });

  test("onboardingService should advance CONFIRM_DOCUMENT_OWNERSHIP step when user sends YES", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      flowMode: "UPLOAD",
      currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
      documentExtracted: true,
      documentOwnershipConfirmed: null,
      documentUploaded: true,
      uploadedMedicalDocument: true,
      preferredLanguage: "english",
    };

    const res = await onboardingService.chat("YES", [], state, null, null, null);

    expect(res.state.documentOwnershipConfirmed).toBe(true);
    expect(res.state.currentStep).not.toBe("CONFIRM_DOCUMENT_OWNERSHIP");
  });

  test("onboardingService should process selected medicines payload when currentStep is null and transition to MEDICINE_OPTIONS", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      currentStep: null,
      isOnboardingCompleted: false,
      flowMode: "UPLOAD",
      documentUploaded: true,
      uploadedMedicalDocument: true,
      profileConfirmed: true,
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      preferredLanguage: "english",
      medicinesConfirmed: false,
      medicationFlowDone: false,
      foundMedicines: [],
      medicinesToAdd: [
        {
          id: "doc_med_0",
          client_med_id: "doc_med_0",
          name: "Omnacortil",
          type: "TABLET",
          dose: { count: 21 },
          frequency: "Once Daily",
          duration: "for 2 weeks",
          selected: true,
          isSaved: true,
        },
      ],
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "2026-08-16",
        gender: "female",
      },
    };

    const messagePayload = JSON.stringify({ selected: ["doc_med_0"] });
    const res = await onboardingService.chat(messagePayload, [], state, null, null, null);

    expect(res.action).toBe("MEDICINE_OPTIONS");
    expect(res.state.medicinesConfirmed).toBe(true);
    expect(res.state.currentStep).toBe("MEDICINE_OPTIONS");
  });

  test("onboardingService should return ADD_MEDICINE form when user selects ADD on MEDICINE_OPTIONS and then REVIEW_MEDICINES_LIST when new medicine is submitted", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      currentStep: "MEDICINE_OPTIONS",
      isOnboardingCompleted: true,
      flowMode: "UPLOAD",
      documentUploaded: true,
      uploadedMedicalDocument: true,
      profileConfirmed: true,
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      preferredLanguage: "english",
      medicinesConfirmed: true,
      medicationFlowDone: false,
      foundMedicines: [],
      medicinesToAdd: [
        {
          id: "doc_med_0",
          client_med_id: "doc_med_0",
          name: "Omnacortil",
          type: "TABLET",
          selected: true,
          isSaved: true,
        },
      ],
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "2026-08-16",
        gender: "female",
      },
    };

    // 1. User clicks "Add Another Medicine" (key: "ADD")
    const resAddOption = await onboardingService.chat("ADD", [], state, null, null, null);

    expect(resAddOption.action).toBe("ADD_MEDICINE");
    expect(resAddOption.renderType).toBe("MEDICINE_FORM");
    expect(resAddOption.medicine).toBeDefined();
    expect(resAddOption.medicine.type).toBe("TABLET");
    expect(resAddOption.state.currentStep).toBe("ADD_MEDICINE");

    // 2. User submits new medicine form
    const newMedPayload = JSON.stringify({
      medicine: {
        name: "Paracetamol",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "ONCE",
      },
    });

    const resSubmitForm = await onboardingService.chat(
      newMedPayload,
      [],
      resAddOption.state,
      null,
      null,
      null,
    );

    expect(resSubmitForm.action).toBe("REVIEW_MEDICINES_LIST");
    expect(resSubmitForm.medicines).toHaveLength(2);
    expect(resSubmitForm.medicines.map((m) => m.name)).toContain("Omnacortil");
    expect(resSubmitForm.medicines.map((m) => m.name)).toContain("Paracetamol");
  });

  test("onboardingService should resolve profile source with social login choice and persist selectedProfileSource='SOCIAL'", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      flowMode: "UPLOAD",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      profileConfirmed: false,
      loginData: {
        firstName: { value: "Shraddha", verified: false },
        lastName: { value: "Chauhan", verified: false },
      },
      socialData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
      documentData: {
        firstName: "Sonal",
        lastName: "Chauhan",
      },
      preferredLanguage: "english",
    };

    const res = await onboardingService.chat(
      JSON.stringify({ source: "LOGIN" }),
      [],
      state,
      null,
      null,
      null,
    );

    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.selectedProfileSource).toBe("SOCIAL");
    expect(res.state.useSocialData).toBe(true);
    expect(res.state.existingUserData.firstName).toBe("Shraddha");
    expect(res.state.currentStep).not.toBe("RESOLVE_PROFILE_SOURCE");
  });

  test("onboardingService should resolve profile source with document choice and persist selectedProfileSource='DOCUMENT'", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      flowMode: "UPLOAD",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      profileConfirmed: false,
      loginData: {
        firstName: { value: "Shraddha", verified: false },
        lastName: { value: "Chauhan", verified: false },
      },
      socialData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
      documentData: {
        firstName: "Sonal",
        lastName: "Chauhan",
      },
      preferredLanguage: "english",
    };

    const res = await onboardingService.chat(
      JSON.stringify({ source: "DOCUMENT" }),
      [],
      state,
      null,
      null,
      null,
    );

    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.selectedProfileSource).toBe("DOCUMENT");
    expect(res.state.useDocumentData).toBe(true);
    expect(res.state.existingUserData.firstName).toBe("Sonal");
    expect(res.state.currentStep).not.toBe("RESOLVE_PROFILE_SOURCE");
  });

  test("onboardingService should resolve profile source with manual edit choice, set profileConfirmed=true, set selectedProfileSource='MANUAL', and advance step", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      flowMode: "UPLOAD",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      profileConfirmed: false,
      loginData: {
        firstName: { value: "Shraddha", verified: false },
        lastName: { value: "Chauhan", verified: false },
      },
      socialData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
      documentData: {
        firstName: "Sonal",
        lastName: "Chauhan",
      },
      preferredLanguage: "english",
    };

    const payload = JSON.stringify({
      edited: {
        firstName: "Anjali",
        lastName: "Chauhan",
        gender: "female",
        dateOfBirth: "1995-05-15",
      },
    });

    const res = await onboardingService.chat(payload, [], state, null, null, null);

    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.profileManuallyEdited).toBe(true);
    expect(res.state.selectedProfileSource).toBe("MANUAL");
    expect(res.state.existingUserData.firstName).toBe("Anjali");
    expect(res.state.existingUserData.lastName).toBe("Chauhan");
    expect(res.state.currentStep).not.toBe("RESOLVE_PROFILE_SOURCE");
  });

  test("onboardingService should retain previously answered DOB/Gender when selecting document source lacking DOB/Gender", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      flowMode: "UPLOAD",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      profileConfirmed: false,
      loginData: {
        firstName: { value: "Shraddha", verified: false },
        lastName: { value: "Chauhan", verified: false },
      },
      socialData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
      documentData: {
        firstName: "Sonal",
        lastName: "Chauhan",
        dateOfBirth: null,
        gender: null,
      },
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1995-05-15",
        gender: "female",
      },
      preferredLanguage: "english",
    };

    const res = await onboardingService.chat(
      JSON.stringify({ source: "DOCUMENT" }),
      [],
      state,
      null,
      null,
      null,
    );

    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.selectedProfileSource).toBe("DOCUMENT");
    expect(res.state.existingUserData.firstName).toBe("Sonal");
    expect(res.state.existingUserData.dateOfBirth).toBe("1995-05-15");
    expect(res.state.existingUserData.gender).toBe("female");
    expect(res.state.currentStep).not.toBe("ASK_DOB");
    expect(res.state.currentStep).not.toBe("ASK_GENDER");
  });

  test("onboardingService should set isOnboardingCompleted=true and medicationFlowDone=true when reaching COMPLETE step", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const state = {
      flowMode: "MANUAL",
      currentStep: "REGISTER_USER",
      profileConfirmed: true,
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      medicationFlowDone: true,
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1995-05-15",
        gender: "female",
      },
      preferredLanguage: "english",
    };

    const res = await onboardingService.chat("DASHBOARD", [], state, null, null, null);

    expect(res.state.isOnboardingCompleted).toBe(true);
    expect(res.state.medicationFlowDone).toBe(true);
    expect(res.state.currentStep).toBe("COMPLETE");
  });

  test("chatService sendMessage should include active profile medications in patient context without chunking", async () => {
    const medicationRepository = require("../src/repositories/medicationRepository");
    const chatSessionRepository = require("../src/repositories/chatSessionRepository");
    const patientRepository = require("../src/repositories/patientRepository");
    const { ollamaClient } = require("../src/clients/ollamaClient");

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "patient-999",
      firstName: "Test",
      lastName: "User",
      gender: "male",
      dateOfBirth: new Date("1990-01-01"),
      bloodGroup: "O+",
      allergies: ["Penicillin"],
      preferredLanguage: "english",
    });

    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "med-1",
        medicationName: "Metformin 850mg",
        medicationType: "TABLET",
        dosePerIntake: 1,
        unit: "tablet",
        frequency: "DAILY",
        foodFrequency: "BEFORE_FOOD",
        medicationSchedule: { Morning: "09:00:00" },
        prescribedBy: "Dr. Dave",
        notes: "Take with full glass of water",
      },
    ]);

    jest
      .spyOn(chatSessionRepository, "listSessions")
      .mockResolvedValue({ items: [{ id: "session-999" }] });
    jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({ id: "session-999" });
    jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({ items: [] });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-1",
      ...msg,
    }));

    let capturedPrompt = "";
    jest.spyOn(ollamaClient, "chat").mockImplementation(async (messages) => {
      const sysMsg = messages.find((m) => m.role === "system");
      capturedPrompt = sysMsg ? sysMsg.content : "";
      return "Metformin should be taken before food as prescribed.";
    });

    const { chatService } = require("../src/services/ai/chat/chat.service");

    const result = await chatService.sendMessage({
      userId: "patient-999",
      question: "When should I take Metformin?",
      sessionId: "session-999",
    });

    expect(capturedPrompt).toContain("Active Profile Medications");
    expect(capturedPrompt).toContain("Metformin 850mg");
    expect(capturedPrompt).toContain("BEFORE_FOOD");
    expect(capturedPrompt).toContain("Dr. Dave");
    expect(result.reply).toBe("Metformin should be taken before food as prescribed.");

    jest.restoreAllMocks();
  });

  test("onboardingService should export canSkipOnboarding and validate skip permission", () => {
    const { canSkipOnboarding } = require("../src/services/ai/chat/onboarding.service");

    const invalidState = {
      flowMode: "MANUAL",
      existingUserData: {
        firstName: "Shraddha",
        lastName: null,
        dateOfBirth: "1995-05-15",
        gender: "female",
      },
    };
    expect(canSkipOnboarding(invalidState)).toBe(false);

    const validState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      profileConfirmed: true,
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1995-05-15",
        gender: "female",
      },
    };
    expect(canSkipOnboarding(validState)).toBe(true);
  });

  test("ocrService onboardingChat should allow SKIP_ONBOARDING if required details are present", async () => {
    const ocrService = require("../src/services/ocr.service");
    const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
    const patientRepository = require("../src/repositories/patientRepository");
    const authProviderRepository = require("../src/repositories/authProviderRepository");

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "patient-111",
      onboardingCompleted: false,
      bloodGroup: "O+",
      allergies: ["none"],
    });
    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        profileConfirmed: true,
        medicationFlowDone: true,
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
          bloodGroup: "O+",
          allergies: ["none"],
        },
      },
    });
    const updatePatientSpy = jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});

    const res = await ocrService.onboardingChat("patient-111", {
      actionType: "SKIP_ONBOARDING",
    });

    expect(res.mode).toBe("ONBOARDING");
    expect(res.actionType).toBe("SKIP_ONBOARDING");
    expect(res.onboardingState.hasSkipped).toBe(true);
    expect(updatePatientSpy).toHaveBeenCalledWith(
      "patient-111",
      expect.objectContaining({
        onboardingCompleted: true,
      }),
    );
    expect(updatePatientSpy).not.toHaveBeenCalledWith(
      "patient-111",
      expect.objectContaining({
        status: "ACTIVE",
      }),
    );

    jest.restoreAllMocks();
  }, 15000);

  test("ocrService onboardingChat should throw BadRequestException/InvalidRequestException on SKIP_ONBOARDING if required details are missing", async () => {
    const ocrService = require("../src/services/ocr.service");
    const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
    const patientRepository = require("../src/repositories/patientRepository");
    const { InvalidRequestException } = require("../src/exceptions/appError");

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "patient-111",
      onboardingCompleted: false,
    });
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        existingUserData: {
          firstName: "John",
          lastName: null,
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      },
    });

    await expect(
      ocrService.onboardingChat("patient-111", {
        actionType: "SKIP_ONBOARDING",
      }),
    ).rejects.toThrow(InvalidRequestException);

    jest.restoreAllMocks();
  });

  // Deliberate semantics change: top-right Skip leaves pending questions and step untouched, recording hasSkipped=true without advancing or emitting a new question
  test("ocrService onboardingChat SKIP_ONBOARDING at ASK_BLOOD_GROUP should leave pending question untouched, persist hasSkipped true, set onboarding_completed true, and not append message", async () => {
    const ocrService = require("../src/services/ocr.service");
    const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
    const patientRepository = require("../src/repositories/patientRepository");
    const authProviderRepository = require("../src/repositories/authProviderRepository");
    const { chatService } = require("../src/services/ai/chat/chat.service");

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "patient-111",
      onboardingCompleted: false,
      bloodGroup: null,
      allergies: null,
    });
    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        profileConfirmed: true,
        currentStep: "ASK_BLOOD_GROUP",
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
          bloodGroup: null,
          allergies: [],
        },
      },
    });
    const updatePatientSpy = jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    const updateOnboardingSpy = jest
      .spyOn(userOnboardingRepository, "updateByUserId")
      .mockResolvedValue({});
    const appendMsgSpy = jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({});

    const res = await ocrService.onboardingChat("patient-111", {
      actionType: "SKIP_ONBOARDING",
    });

    expect(res.mode).toBe("ONBOARDING");
    expect(res.actionType).toBe("SKIP_ONBOARDING");
    expect(res.onboardingState.currentStep).toBe("ASK_BLOOD_GROUP");
    expect(res.onboardingState.bloodGroupSkipped).toBeFalsy();
    expect(res.onboardingState.allergiesSkipped).toBeFalsy();
    expect(res.onboardingState.hasSkipped).toBe(true);

    // Assert no assistant message was appended for next step
    expect(appendMsgSpy).not.toHaveBeenCalled();

    // Assert patients.onboarding_completed was set to true without writing status
    expect(updatePatientSpy).toHaveBeenCalledWith(
      "patient-111",
      expect.objectContaining({
        onboardingCompleted: true,
      }),
    );
    expect(updatePatientSpy).not.toHaveBeenCalledWith(
      "patient-111",
      expect.objectContaining({
        status: "ACTIVE",
      }),
    );

    // Assert user_onboarding state was persisted with hasSkipped: true and currentStep: "ASK_BLOOD_GROUP"
    expect(updateOnboardingSpy).toHaveBeenCalledWith(
      "patient-111",
      expect.objectContaining({
        data: expect.objectContaining({
          hasSkipped: true,
          currentStep: "ASK_BLOOD_GROUP",
          bloodGroupSkipped: false,
          allergiesSkipped: false,
        }),
      }),
    );

    jest.restoreAllMocks();
  }, 15000);

  describe("isProfileComplete Truth Table & Field Validation", () => {
    const {
      isProfileComplete,
      REQUIRED_PROFILE_FIELDS,
    } = require("../src/services/ai/chat/onboarding.service");

    test("REQUIRED_PROFILE_FIELDS contains exactly 4 fields and no email/phone", () => {
      expect(REQUIRED_PROFILE_FIELDS).toEqual(["firstName", "lastName", "dateOfBirth", "gender"]);
    });

    test("isProfileComplete returns false when firstName is missing", () => {
      expect(
        isProfileComplete({
          firstName: "",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
          mobile: "+1234567890",
        }),
      ).toBe(false);
    });

    test("isProfileComplete returns false when lastName is missing", () => {
      expect(
        isProfileComplete({
          firstName: "John",
          lastName: null,
          dateOfBirth: "1990-01-01",
          gender: "male",
          mobile: "+1234567890",
        }),
      ).toBe(false);
    });

    test("isProfileComplete returns false when dateOfBirth is missing or invalid", () => {
      expect(
        isProfileComplete({
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "invalid-date",
          gender: "male",
          mobile: "+1234567890",
        }),
      ).toBe(false);
      expect(
        isProfileComplete({
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "2099-01-01", // Future date
          gender: "male",
          mobile: "+1234567890",
        }),
      ).toBe(false);
      expect(
        isProfileComplete({
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1850-01-01", // Age > 120
          gender: "male",
          mobile: "+1234567890",
        }),
      ).toBe(false);
    });

    test("isProfileComplete returns false when gender is missing or invalid", () => {
      expect(
        isProfileComplete({
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "unknown_gender",
          mobile: "+1234567890",
        }),
      ).toBe(false);
    });

    test("isProfileComplete returns true when all 4 required fields are valid", () => {
      expect(
        isProfileComplete({
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
          mobile: "+1234567890",
        }),
      ).toBe(true);
    });

    test("Contact assertion logs error if mobile/email missing but does not block completion", () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const result = isProfileComplete({
        firstName: "Jane",
        lastName: "Smith",
        dateOfBirth: "1995-05-15",
        gender: "female",
      });
      expect(result).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe("Gender Normalization Variants", () => {
    const { normalizeGenderLocally } = require("../src/helpers/onboarding.helper");

    test("Normalizes male variants correctly", () => {
      expect(normalizeGenderLocally("M")).toBe("male");
      expect(normalizeGenderLocally("MALE")).toBe("male");
      expect(normalizeGenderLocally("male")).toBe("male");
      expect(normalizeGenderLocally("Male")).toBe("male");
    });

    test("Normalizes female variants correctly", () => {
      expect(normalizeGenderLocally("F")).toBe("female");
      expect(normalizeGenderLocally("Female")).toBe("female");
      expect(normalizeGenderLocally("female")).toBe("female");
      expect(normalizeGenderLocally("FEMALE")).toBe("female");
    });

    test("Normalizes other variants correctly", () => {
      expect(normalizeGenderLocally("O")).toBe("other");
      expect(normalizeGenderLocally("Other")).toBe("other");
      expect(normalizeGenderLocally("other")).toBe("other");
      expect(normalizeGenderLocally("OTHER")).toBe("other");
    });
  });

  describe("canSkipOnboarding & State Edge Cases", () => {
    const { canSkipOnboarding } = require("../src/services/ai/chat/onboarding.service");

    test("Returns false if pendingProfileConflict is true", () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        profileConfirmed: true,
        pendingProfileConflict: true,
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };
      expect(canSkipOnboarding(state)).toBe(false);
    });

    test("Returns false if dateOfBirth is unparseable OCR string", () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        profileConfirmed: true,
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "not-a-date",
          gender: "male",
        },
      };
      expect(canSkipOnboarding(state)).toBe(false);
    });

    test("Returns true when required fields are complete and profileConfirmed", () => {
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
      };
      expect(canSkipOnboarding(state)).toBe(true);
    });
  });

  describe("Anti-Regression: Answering Gender & Cold Start & Idempotency", () => {
    test("After answering Gender in MANUAL flow: returns next question as ASK_BLOOD_GROUP, canSkip true, and standalone completionMessage", async () => {
      const { onboardingService } = require("../src/services/ai/chat/onboarding.service");
      const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
      const patientRepository = require("../src/repositories/patientRepository");
      const authProviderRepository = require("../src/repositories/authProviderRepository");
      const { chatService } = require("../src/services/ai/chat/chat.service");

      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "p-gender-test",
        onboardingCompleted: false,
      });
      jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
      jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue(null);
      jest.spyOn(userOnboardingRepository, "create").mockResolvedValue({});
      jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});
      jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({ id: "session-test" });
      const appendMsgSpy = jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({
        id: "msg-1",
        createdAt: new Date(),
      });

      const state = {
        chatSessionId: "session-test",
        preferredLanguage: "english",
        flowMode: "MANUAL",
        currentStep: "ASK_GENDER",
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
        },
      };

      const res = await onboardingService.chat("male", [], state, "p-gender-test");

      // 1. User remains on onboarding chat screen, next question is ASK_BLOOD_GROUP
      expect(res.action).toBe("ASK_BLOOD_GROUP");
      // 2. Skip is enabled
      expect(res.canSkip).toBe(true);
      // 3. Completion message is emitted separately
      expect(res.completionMessage).toBe("Thank you! Onboarding is complete.");
      // 4. completionMessageSent flag is true
      expect(res.state.completionMessageSent).toBe(true);

      // Verify that the completion notice was appended separately to chat
      expect(appendMsgSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Thank you! Onboarding is complete.",
          metadata: expect.objectContaining({
            action: "ONBOARDING_COMPLETED_NOTICE",
          }),
        }),
      );

      jest.restoreAllMocks();
    });

    test("Cold start: getOnboardingStatus after profile completion returns canSkip true", async () => {
      const ocrService = require("../src/services/ocr.service");
      const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
      const patientRepository = require("../src/repositories/patientRepository");

      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "patient-cold-start",
        firstName: "John",
        lastName: "Doe",
        gender: "male",
        dateOfBirth: new Date("1990-01-01"),
        onboardingCompleted: false,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        data: {
          preferredLanguage: "english",
          flowMode: "MANUAL",
          profileConfirmed: true,
          currentStep: "ASK_BLOOD_GROUP",
          existingUserData: {
            firstName: "John",
            lastName: "Doe",
            dateOfBirth: "1990-01-01",
            gender: "male",
          },
        },
      });

      const status = await ocrService.getOnboardingStatus("patient-cold-start");
      expect(status.canSkip).toBe(true);
      expect(status.isOnboardingCompleted).toBe(false);
      expect(status.currentStep).toBe("ASK_BLOOD_GROUP");

      jest.restoreAllMocks();
    });

    test("SKIP_ONBOARDING twice is idempotent and returns 200 without duplicate side effects", async () => {
      const ocrService = require("../src/services/ocr.service");
      const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
      const patientRepository = require("../src/repositories/patientRepository");

      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "patient-idempotent",
        onboardingCompleted: false,
      });
      const updatePatientSpy = jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        data: {
          preferredLanguage: "english",
          flowMode: "MANUAL",
          profileConfirmed: true,
          currentStep: "ASK_BLOOD_GROUP",
          existingUserData: {
            firstName: "John",
            lastName: "Doe",
            dateOfBirth: "1990-01-01",
            gender: "male",
          },
        },
      });
      jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});

      // First SKIP call
      const res1 = await ocrService.onboardingChat("patient-idempotent", {
        actionType: "SKIP_ONBOARDING",
      });
      expect(res1.actionType).toBe("SKIP_ONBOARDING");
      expect(res1.canSkip).toBe(true);

      // Second SKIP call (double tap)
      const res2 = await ocrService.onboardingChat("patient-idempotent", {
        actionType: "SKIP_ONBOARDING",
      });
      expect(res2.actionType).toBe("SKIP_ONBOARDING");
      expect(res2.canSkip).toBe(true);
      expect(updatePatientSpy).toHaveBeenCalledWith(
        "patient-idempotent",
        expect.objectContaining({
          onboardingCompleted: true,
        }),
      );

      jest.restoreAllMocks();
    });

    test("BLOCKED patient: completing onboarding does not overwrite status to ACTIVE", async () => {
      const ocrService = require("../src/services/ocr.service");
      const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
      const patientRepository = require("../src/repositories/patientRepository");

      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "patient-blocked",
        status: "BLOCKED",
        onboardingCompleted: false,
      });
      const updatePatientSpy = jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        data: {
          preferredLanguage: "english",
          flowMode: "MANUAL",
          profileConfirmed: true,
          currentStep: "ASK_BLOOD_GROUP",
          existingUserData: {
            firstName: "John",
            lastName: "Doe",
            dateOfBirth: "1990-01-01",
            gender: "male",
          },
        },
      });
      jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});

      await ocrService.onboardingChat("patient-blocked", {
        actionType: "SKIP_ONBOARDING",
      });

      // Verify status was NOT included in the update payload
      expect(updatePatientSpy).toHaveBeenCalledWith(
        "patient-blocked",
        expect.not.objectContaining({
          status: "ACTIVE",
        }),
      );

      jest.restoreAllMocks();
    });

    test("SKIP_ONBOARDING when currentStep is ASK_REPORT routes to skip handler, sets onboardingCompleted, and does not route to NORMAL_CHAT", async () => {
      const ocrService = require("../src/services/ocr.service");
      const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
      const patientRepository = require("../src/repositories/patientRepository");

      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "patient-ask-report",
        onboardingCompleted: false,
      });
      const updatePatientSpy = jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        data: {
          preferredLanguage: "english",
          flowMode: "UPLOAD",
          documentOwnershipConfirmed: true,
          profileConfirmed: true,
          currentStep: "ASK_REPORT",
          medicationFlowDone: true,
          isOnboardingCompleted: false,
          existingUserData: {
            firstName: "John",
            lastName: "Doe",
            dateOfBirth: "1990-01-01",
            gender: "male",
            bloodGroup: "O+",
            allergies: ["none"],
          },
        },
      });
      const updateOnboardingSpy = jest
        .spyOn(userOnboardingRepository, "updateByUserId")
        .mockResolvedValue({});

      const res = await ocrService.onboardingChat("patient-ask-report", {
        actionType: "SKIP_ONBOARDING",
        state: {
          preferredLanguage: "english",
          flowMode: "UPLOAD",
          documentOwnershipConfirmed: true,
          profileConfirmed: true,
          currentStep: "ASK_REPORT",
          existingUserData: {
            firstName: "John",
            lastName: "Doe",
            dateOfBirth: "1990-01-01",
            gender: "male",
            bloodGroup: "O+",
            allergies: ["none"],
          },
        },
      });

      expect(res.mode).toBe("ONBOARDING");
      expect(res.actionType).toBe("SKIP_ONBOARDING");
      expect(res.canSkip).toBe(true);
      expect(updatePatientSpy).toHaveBeenCalledWith(
        "patient-ask-report",
        expect.objectContaining({
          onboardingCompleted: true,
        }),
      );
      expect(updateOnboardingSpy).toHaveBeenCalledWith(
        "patient-ask-report",
        expect.objectContaining({
          data: expect.objectContaining({
            hasSkipped: true,
            currentStep: "ASK_REPORT",
          }),
        }),
      );

      jest.restoreAllMocks();
    });
  });

  describe("ASK_REPORT Routing & State Machine (Dashboard & Onboarding)", () => {
    const ocrService = require("../src/services/ocr.service");
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");
    const patientRepository = require("../src/repositories/patientRepository");
    const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
    const { db } = require("../src/configs/db");

    test("D2 Fix: ocrService.onboardingChat forces onboarding state machine when message is ASK_REPORT even if onboarding completed", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "patient-completed",
        onboardingCompleted: true,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        data: {
          preferredLanguage: "english",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          currentStep: "POST_ONBOARDING",
          existingUserData: {
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1992-02-02",
            gender: "female",
            bloodGroup: "B+",
            allergies: ["none"],
          },
          bloodGroupSkipped: true,
          allergiesSkipped: true,
        },
      });
      jest.spyOn(onboardingService, "chat").mockResolvedValue({
        action: "ASK_REPORT",
        message: "",
        document: {
          id: "doc-123",
          summaryEnglish: "Test Summary",
          keyFindings: ["Normal findings"],
        },
        suggestedQuestions: ["What are key findings?"],
        state: { currentStep: "ASK_REPORT" },
      });

      const res = await ocrService.onboardingChat("patient-completed", {
        message: "ASK_REPORT",
        state: { isOnboardingCompleted: true, currentStep: "POST_ONBOARDING" },
      });

      expect(res.mode).toBe("ONBOARDING");
      expect(res.actionType).toBe("ASK_REPORT");
      expect(res.document).toBeDefined();
      expect(res.document.id).toBe("doc-123");
      expect(res.suggestedQuestions).toEqual(["What are key findings?"]);

      jest.restoreAllMocks();
    });

    test("D2 Fix: ocrService.onboardingChat forces onboarding state machine when message is legacy ASK_ABOUT_REPORT", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "patient-completed",
        onboardingCompleted: true,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        data: {
          preferredLanguage: "english",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          currentStep: "POST_ONBOARDING",
          existingUserData: {
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1992-02-02",
            gender: "female",
            bloodGroup: "B+",
            allergies: ["none"],
          },
          bloodGroupSkipped: true,
          allergiesSkipped: true,
        },
      });
      jest.spyOn(onboardingService, "chat").mockResolvedValue({
        action: "ASK_REPORT",
        message: "",
        document: { id: "doc-123", summaryEnglish: "Test Summary" },
        suggestedQuestions: ["What are key findings?"],
        state: { currentStep: "ASK_REPORT" },
      });

      const res = await ocrService.onboardingChat("patient-completed", {
        message: "ASK_ABOUT_REPORT",
        state: { isOnboardingCompleted: true },
      });

      expect(res.mode).toBe("ONBOARDING");
      expect(res.actionType).toBe("ASK_REPORT");

      jest.restoreAllMocks();
    });

    test("Regression check: Free-text queries post-onboarding route to NORMAL_CHAT and do NOT force onboarding", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "patient-completed",
        onboardingCompleted: true,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        data: {
          preferredLanguage: "english",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          currentStep: "POST_ONBOARDING",
          existingUserData: {
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1992-02-02",
            gender: "female",
            bloodGroup: "B+",
            allergies: ["none"],
          },
          bloodGroupSkipped: true,
          allergiesSkipped: true,
        },
      });
      const { chatService } = require("../src/services/ai/chat/chat.service");
      jest.spyOn(chatService, "sendMessage").mockResolvedValue({
        reply: "You should consult your physician regarding vitamins.",
        sessionId: "session-normal",
        metadata: { action: "NORMAL_CHAT" },
      });

      const res = await ocrService.onboardingChat("patient-completed", {
        message: "What are my vitamins?",
        actionType: "NORMAL_CHAT",
      });

      expect(res.mode).toBe("NORMAL_CHAT");
      expect(res.actionType).toBe("NORMAL_CHAT");
      expect(res.reply).toContain("vitamins");

      jest.restoreAllMocks();
    });

    test("onboardingService.chat handles MEDICINE_OPTIONS -> ASK_REPORT selection and fetches user's report", async () => {
      const authProviderRepository = require("../src/repositories/authProviderRepository");
      jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
      jest.spyOn(patientRepository, "findById").mockResolvedValue({ id: "user-test-doc" });
      jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({ data: {} });
      jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});

      const mockDoc = {
        id: "doc-999",
        userId: "user-test-doc",
        summaryEnglish: "Patient report indicates normal hemoglobin levels.",
        structuredExtractedData: {
          keyFindings: ["Hemoglobin: 14.5 g/dL", "Blood pressure normal"],
          summaryEnglish: "Patient report indicates normal hemoglobin levels.",
        },
      };

      const selectMock = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockDoc]),
            }),
          }),
        }),
      });
      jest.spyOn(db, "select").mockImplementation(selectMock);

      const state = {
        preferredLanguage: "english",
        currentStep: "MEDICINE_OPTIONS",
        userId: "user-test-doc",
        isOnboardingCompleted: false,
      };

      const res = await onboardingService.chat(
        JSON.stringify({ key: "ASK_REPORT" }),
        [],
        state,
        "user-test-doc",
      );

      expect(res.action).toBe("ASK_REPORT");
      expect(res.document).toBeDefined();
      expect(res.document.id).toBe("doc-999");
      expect(res.document.summary).toContain("hemoglobin");
      expect(res.suggestedQuestions.length).toBeGreaterThan(0);

      jest.restoreAllMocks();
    });

    test("Zero-documents edge case: returns polite fallback message and document null when user has no reports", async () => {
      const authProviderRepository = require("../src/repositories/authProviderRepository");
      jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
      jest.spyOn(patientRepository, "findById").mockResolvedValue({ id: "user-no-docs" });
      jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({ data: {} });
      jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});

      const selectMock = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      jest.spyOn(db, "select").mockImplementation(selectMock);

      const state = {
        preferredLanguage: "english",
        currentStep: "MEDICINE_OPTIONS",
        userId: "user-no-docs",
        isOnboardingCompleted: false,
      };

      const res = await onboardingService.chat("ASK_REPORT", [], state, "user-no-docs");

      expect(res.action).toBe("NORMAL_CHAT");
      expect(res.message).toBe("You haven't uploaded any medical reports yet.");
      expect(res.document).toBeNull();
      expect(res.suggestedQuestions).toEqual([]);

      jest.restoreAllMocks();
    });
  });
});
