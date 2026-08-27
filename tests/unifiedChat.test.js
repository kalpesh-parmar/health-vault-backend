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

  test("chatService sendMessage should return report summary, calculate age, translate summary, stream response, and return predefined questions", async () => {
    const patientRepository = require("../src/repositories/patientRepository");
    const chatSessionRepository = require("../src/repositories/chatSessionRepository");
    const aiClient = require("../src/services/ai/clients/aiClient.service");
    const { db } = require("../src/configs/db");

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "patient-777",
      firstName: "Shraddha",
      lastName: "Chauhan",
      preferredLanguage: "gujarati",
    });

    const mockReportDate = new Date();
    mockReportDate.setDate(mockReportDate.getDate() - 10); // 10 days ago

    const mockDocumentRecord = {
      id: "doc-777",
      userId: "patient-777",
      fileName: "report.pdf",
      ocrStatus: "completed",
      summaryEnglish: "Patient has normal hemoglobin levels.",
      reportDate: mockReportDate,
      createdAt: new Date(),
      structuredExtractedData: {
        patient: { name: "Shraddha Chauhan" },
      },
    };

    const mockSelect = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([mockDocumentRecord]),
    };
    jest.spyOn(db, "select").mockReturnValue(mockSelect);

    jest.spyOn(aiClient, "translate").mockImplementation(async (text, src, tgt) => {
      if (tgt === "gujarati") {
        return "દર્દી પાસે સામાન્ય હિમોગ્લોબિન સ્તર છે.";
      }
      return text;
    });

    jest
      .spyOn(chatSessionRepository, "listSessions")
      .mockResolvedValue({ items: [{ id: "session-777" }] });
    jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({ id: "session-777" });
    jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({ items: [] });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-777",
      ...msg,
    }));

    const streamedChunks = [];
    const onChunk = (chunk) => {
      streamedChunks.push(chunk);
    };

    const { chatService } = require("../src/services/ai/chat/chat.service");

    const result = await chatService.sendMessage({
      userId: "patient-777",
      question: "tell me about my report",
      sessionId: "session-777",
      onChunk,
    });

    expect(result.reply).toContain("Shraddha Chauhan");
    expect(result.reply).toContain("10 દિવસ જૂનો");
    expect(result.reply).toContain("દર્દી પાસે સામાન્ય હિમોગ્લોબિન સ્તર છે.");
    expect(result.options).toHaveLength(3);
    expect(result.options[0].label).toBe("મુખ્ય તારણો શું છે?");
    expect(result.options[0].value).toBe("મુખ્ય તારણો શું છે?");
    expect(result.options[0].actionType).toBe("CHAT");

    expect(streamedChunks.length).toBeGreaterThan(0);
    expect(streamedChunks.join("")).toContain("10 દિવસ જૂનો");

    jest.restoreAllMocks();
  });

  test("ocrService onboardingChat should complete onboarding and return report summary when user sends ASK_REPORT", async () => {
    const patientRepository = require("../src/repositories/patientRepository");
    const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");
    const { chatService } = require("../src/services/ai/chat/chat.service");
    const ocrService = require("../src/services/ocr.service");

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "patient-777",
      firstName: "Shraddha",
      lastName: "Chauhan",
      preferredLanguage: "gujarati",
    });

    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: { isOnboardingCompleted: false, currentStep: "MEDICINE_OPTIONS" },
    });

    jest.spyOn(onboardingService, "chat").mockResolvedValue({
      action: "COMPLETE",
      state: {
        isOnboardingCompleted: true,
        currentStep: "COMPLETE",
        preferredLanguage: "gujarati",
        documentId: "doc-777",
      },
    });

    jest.spyOn(chatService, "createSession").mockResolvedValue({
      id: "session-777",
    });

    jest.spyOn(chatService, "sendMessage").mockResolvedValue({
      reply: "Mocked Report Summary",
      options: [{ label: "Findings?", value: "Findings?", actionType: "CHAT" }],
    });

    const result = await ocrService.onboardingChat("patient-777", {
      message: "ASK_REPORT",
    });

    expect(result.mode).toBe("NORMAL_CHAT");
    expect(result.actionType).toBe("NORMAL_CHAT");
    expect(result.reply).toBe("Mocked Report Summary");
    expect(result.options).toHaveLength(1);
    expect(result.options[0].label).toBe("Findings?");

    expect(chatService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: ["doc-777"],
      }),
    );

    jest.restoreAllMocks();
  });

  test("onboardingService should preserve activeMedicine and manual medicines when merging document extracted medicines", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const mockState = {
      flowMode: "UPLOAD",
      currentStep: "REVIEW_MEDICINES_LIST",
      activeMedicine: {
        id: "med_1787291544368_8907",
        name: "Insulin",
        type: "TABLET",
        source: "MANUAL",
      },
      foundMedicines: [{ name: "MBSON SL" }, { name: "Caldison D3" }],
      medicinesToAdd: [
        { id: "doc_med_0", name: "MBSON SL", source: "OCR" },
        { id: "doc_med_1", name: "Caldison D3", source: "OCR" },
      ],
    };

    const res = await onboardingService.chat("", [], mockState, null);

    const medNames = res.state.medicinesToAdd.map((m) => m.name || m.medicationName);
    expect(medNames).toContain("Insulin");
    expect(medNames).toContain("MBSON SL");
    expect(medNames).toContain("Caldison D3");
  });

  test("onboardingService should append new medicine when ADD_MEDICINE is called even if currentMedicineIndex was set", async () => {
    const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

    const mockState = {
      flowMode: "UPLOAD",
      currentStep: "EDIT_MEDICINE",
      currentMedicineIndex: 2,
      medicinesToAdd: [
        { id: "doc_med_0", name: "MBSON SL", source: "OCR" },
        { id: "doc_med_1", name: "Caldison D3", source: "OCR" },
        { id: "med_1", name: "Insulin", source: "MANUAL" },
        { id: "med_2", name: "Omnacortil 20", source: "MANUAL" },
      ],
    };

    const newMedPayload = JSON.stringify({
      name: "Omnacortil 40",
      type: "TABLET",
      addNew: true,
    });

    const res = await onboardingService.chat(newMedPayload, [], mockState, null);

    const medNames = res.state.medicinesToAdd.map((m) => m.name || m.medicationName);
    expect(medNames).toContain("MBSON SL");
    expect(medNames).toContain("Caldison D3");
    expect(medNames).toContain("Insulin");
    expect(medNames).toContain("Omnacortil 20");
    expect(medNames).toContain("Omnacortil 40");
    expect(res.state.medicinesToAdd.length).toBe(5);
  });

  test("post-onboarding medicine confirmation with string IDs should resolve document medication and persist to DB", async () => {
    const patientRepository = require("../src/repositories/patientRepository");
    const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
    const chatSessionRepository = require("../src/repositories/chatSessionRepository");
    const medicationService = require("../src/services/medication.service");
    const medicationReminderService = require("../src/services/medicationReminder.service");
    const ocrService = require("../src/services/ocr.service");

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-123",
      firstName: "Shraddha",
      onboardingCompleted: true,
    });
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      data: { isOnboardingCompleted: true, currentStep: "POST_ONBOARDING" },
    });
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-123" });
    jest.spyOn(medicationService, "createMedication").mockResolvedValue({
      id: "created-med-123",
      medicationName: "inj. meropenum",
      medicationType: "TABLET",
    });
    jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({ id: "rem-123" });

    const reqBody = {
      actionType: "CONFIRM_MEDICINES",
      actionData: {
        medicines: ["extracted_med_1", "extracted_med_2"],
      },
      message: "Confirm Selection",
      sessionId: "session-123",
      state: { isOnboardingCompleted: true },
    };

    const response = await ocrService.onboardingChat("user-123", reqBody, null);

    expect(response.actionType).toBe("CONFIRM_MEDICINES");
    expect(medicationService.createMedication).toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  test("normalizeCreateMedicationInput should strip extra OCR keys like id, dosage, timing, instructions to pass Zod .strict()", () => {
    const rawOcrInput = {
      id: "extracted_med_1",
      name: "inj. meropenum",
      type: "TABLET",
      dosage: "1 tab",
      timing: "morning",
      instructions: "take with water",
      duplicateInfo: { hasDuplicate: false },
    };

    const sanitized = normalizeCreateMedicationInput(rawOcrInput);

    expect(sanitized.medicationName).toBe("inj. meropenum");
    expect(sanitized.medicationType).toBe("TABLET");
    expect(sanitized.notes).toBe("take with water");
    expect(sanitized.id).toBeUndefined();
    expect(sanitized.dosage).toBeUndefined();
    expect(sanitized.timing).toBeUndefined();
    expect(sanitized.instructions).toBeUndefined();
    expect(sanitized.duplicateInfo).toBeUndefined();
  });

  test("chatService listMessages should format message metadata into top-level options, medicines, and actionType", async () => {
    const chatSessionRepository = require("../src/repositories/chatSessionRepository");
    const { chatService } = require("../src/services/ai/chat/chat.service");

    jest
      .spyOn(chatSessionRepository, "findSessionById")
      .mockResolvedValue({ id: "session-123", userId: "user-123" });
    jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({
      items: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Found 2 medications",
          metadata: {
            actionType: "REVIEW_MEDICINES_LIST",
            options: [{ label: "Confirm Selected", actionType: "CONFIRM_MEDICINES" }],
            medicines: [{ name: "inj. meropenum" }],
          },
        },
      ],
      nextCursor: null,
    });

    const res = await chatService.listMessages({ sessionId: "session-123", userId: "user-123" });

    expect(res.items[0].actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(res.items[0].options).toHaveLength(1);
    expect(res.items[0].medicines).toHaveLength(1);
    expect(res.items[0].medicines[0].name).toBe("inj. meropenum");

    jest.restoreAllMocks();
  });

  test("chatSessionController sendMessage should handle stream: true with SSE response format", async () => {
    const chatSessionController = require("../src/controllers/chatSession.controller");
    const { chatService } = require("../src/services/ai/chat/chat.service");

    jest.spyOn(chatService, "sendMessage").mockImplementation(async ({ onChunk }) => {
      if (onChunk) {
        onChunk("Hello ");
        onChunk("World!");
      }
      return { reply: "Hello World!", citations: [] };
    });

    const writtenChunks = [];
    const headers = {};

    const req = {
      auth: { userId: "user-123" },
      body: {
        question: "Hello",
        stream: true,
      },
      on: jest.fn(),
      socket: { setTimeout: jest.fn() },
    };

    const res = {
      setHeader: (key, value) => {
        headers[key] = value;
      },
      write: (data) => {
        writtenChunks.push(data);
      },
      end: jest.fn(),
      writableEnded: false,
    };

    await chatSessionController.sendMessage(req, res);

    expect(headers["Content-Type"]).toBe("text/event-stream");
    expect(writtenChunks.some((chunk) => chunk.includes("Hello "))).toBe(true);
    expect(writtenChunks.some((chunk) => chunk.includes("World!"))).toBe(true);
    expect(writtenChunks.some((chunk) => chunk.includes('"type":"done"'))).toBe(true);
    expect(res.end).toHaveBeenCalled();

    jest.restoreAllMocks();
  });
});
