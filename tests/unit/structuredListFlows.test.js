const { chatService } = require("../../src/services/ai/chat/chat.service");
const { buildDependencyAwareContext } = require("../../src/services/ai/chat/ragContext.service");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const patientRepository = require("../../src/repositories/patientRepository");

describe("Unified Structured List & Deduplication Flow Tests", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("1. Document listing queries intercept before LLM and return STRUCTURED_LIST with pagination", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-doc-123",
      firstName: "Test",
      lastName: "User",
      preferredLanguage: "english",
    });

    jest
      .spyOn(chatSessionRepository, "findSessionById")
      .mockResolvedValue({ id: "session-doc-123" });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-doc-1",
      ...msg,
    }));

    const mockDocs = [
      {
        id: "doc-1",
        fileName: "blood_test.pdf",
        documentType: "lab_report",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-10"),
        ocrStatus: "COMPLETED",
        remarks: null,
      },
      {
        id: "doc-2",
        fileName: "xray_chest.pdf",
        documentType: "radiology",
        fileType: "application/pdf",
        reportDate: new Date("2026-06-15"),
        ocrStatus: "COMPLETED",
        remarks: null,
      },
    ];
    jest.spyOn(documentRepository, "getSummaryByUserId").mockResolvedValue(mockDocs);

    const qwenChatSpy = jest.spyOn(chatService, "qwenHealthChat");

    // 1a. Default returns all available records
    const result = await chatService.sendMessage({
      userId: "user-doc-123",
      question: "list all documents",
      sessionId: "session-doc-123",
    });

    expect(qwenChatSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe("STRUCTURED_LIST");
    expect(result.reply).toBeDefined();
    expect(result.reply.items).toHaveLength(2);
    expect(result.reply.items[0].fileName).toBe("blood_test.pdf");
    expect(result.reply.items[0].reportDate).toBe("2026-05-10");
    expect(result.reply.items[0]).not.toHaveProperty("remarks");
    expect(result.reply.items[0].ocrStatus).toBe("COMPLETED");
    expect(result.reply.pagination).toBeDefined();
    expect(result.reply.pagination.totalRecords).toBe(2);
    expect(result.reply.pagination.pageNumber).toBe(1);
    expect(result.reply.pagination.totalPages).toBe(1);
    expect(result.ai.metadata.task).toBe("DOCUMENT_LIST");

    // 1b. Respects explicit pagination if requested by client
    const paginatedResult = await chatService.sendMessage({
      userId: "user-doc-123",
      question: "list all documents",
      sessionId: "session-doc-123",
      page: 1,
      limit: 1,
    });
    expect(paginatedResult.reply.items).toHaveLength(1);
    expect(paginatedResult.reply.pagination.pageLimit).toBe(1);
    expect(paginatedResult.reply.pagination.totalPages).toBe(2);
  });

  test("1b. Document listing queries in other languages (Gujarati, Hindi) intercept and return STRUCTURED_LIST with 1 item per page", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-doc-lang",
      firstName: "Test",
      lastName: "User",
      preferredLanguage: "gujarati",
    });

    jest
      .spyOn(chatSessionRepository, "findSessionById")
      .mockResolvedValue({ id: "session-doc-lang" });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-doc-lang",
      ...msg,
    }));

    const mockDocs = [
      {
        id: "doc-1",
        fileName: "blood_test.pdf",
        documentType: "lab_report",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-10"),
        ocrStatus: "COMPLETED",
        remarks: null,
      },
    ];
    jest.spyOn(documentRepository, "getSummaryByUserId").mockResolvedValue(mockDocs);
    const qwenChatSpy = jest.spyOn(chatService, "qwenHealthChat");

    // Test Gujarati: "મારા દસ્તાવેજો બતાવો"
    const resultGuj = await chatService.sendMessage({
      userId: "user-doc-lang",
      question: "મારા દસ્તાવેજો બતાવો",
      sessionId: "session-doc-lang",
    });

    expect(qwenChatSpy).not.toHaveBeenCalled();
    expect(resultGuj.mode).toBe("STRUCTURED_LIST");
    expect(resultGuj.reply.items).toHaveLength(1);
    expect(resultGuj.reply.items[0].fileName).toBe("blood_test.pdf");
    expect(resultGuj.reply.pagination.pageLimit).toBe(1);

    // Test Hindi: "मेरे दस्तावेज दिखाएं"
    const resultHin = await chatService.sendMessage({
      userId: "user-doc-lang",
      question: "मेरे दस्तावेज दिखाएं",
      sessionId: "session-doc-lang",
    });

    expect(qwenChatSpy).not.toHaveBeenCalled();
    expect(resultHin.mode).toBe("STRUCTURED_LIST");
    expect(resultHin.reply.items).toHaveLength(1);
    expect(resultHin.reply.pagination.pageLimit).toBe(1);
  });

  test("2. Medication listing queries continue to intercept and return STRUCTURED_LIST with pagination", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-med-123",
      firstName: "Test",
      lastName: "User",
      preferredLanguage: "english",
    });

    jest
      .spyOn(chatSessionRepository, "findSessionById")
      .mockResolvedValue({ id: "session-med-123" });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-med-1",
      ...msg,
    }));

    const mockMeds = [
      {
        id: "med-1",
        medicationName: "Metformin",
        medicationType: "TABLET",
        dosePerIntake: "500",
        unit: "mg",
        frequency: "Twice daily",
        prescribedBy: "Dr. Smith",
      },
    ];
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue(mockMeds);

    const qwenChatSpy = jest.spyOn(chatService, "qwenHealthChat");

    const result = await chatService.sendMessage({
      userId: "user-med-123",
      question: "list my medications",
      sessionId: "session-med-123",
    });

    expect(qwenChatSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe("STRUCTURED_LIST");
    expect(result.reply).toBeDefined();
    expect(result.reply.items).toHaveLength(1);
    expect(result.reply.items[0].name).toBe("Metformin");
    expect(result.reply.pagination).toBeDefined();
    expect(result.ai.metadata.task).toBe("MEDICATION_LIST");
  });

  test("3. buildDependencyAwareContext reuses options.patient without re-fetching patientRepository", async () => {
    const findByIdSpy = jest.spyOn(patientRepository, "findById");

    const preloadedPatient = {
      id: "user-999",
      firstName: "Preloaded",
      lastName: "Patient",
      patientCode: "P-999",
      dateOfBirth: "1990-01-01",
      gender: "male",
      status: "ACTIVE",
    };

    const context = await buildDependencyAwareContext("user-999", "what is my name", {
      patient: preloadedPatient,
    });

    expect(findByIdSpy).not.toHaveBeenCalled();
    expect(context).toContain("Preloaded Patient");
    expect(context).toContain("P-999");
  });

  test("4. Document listing filtered by document type across languages (English, Gujarati, Hindi)", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-filter-type",
      firstName: "Test",
      lastName: "User",
      preferredLanguage: "english",
    });

    jest
      .spyOn(chatSessionRepository, "findSessionById")
      .mockResolvedValue({ id: "session-filter-type" });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-filter-type",
      ...msg,
    }));

    const mockDocs = [
      {
        id: "doc-lab-1",
        fileName: "blood_cbc.pdf",
        documentType: "LAB_REPORT",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-10"),
        ocrStatus: "completed",
        remarks: null,
      },
      {
        id: "doc-rx-1",
        fileName: "rx_clinic.pdf",
        documentType: "PRESCRIPTION",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-12"),
        ocrStatus: "completed",
        remarks: null,
      },
      {
        id: "doc-xray-1",
        fileName: "chest_xray.png",
        documentType: "IMAGING_REPORT",
        fileType: "image/png",
        reportDate: new Date("2026-05-15"),
        ocrStatus: "completed",
        remarks: null,
      },
    ];
    jest.spyOn(documentRepository, "getSummaryByUserId").mockResolvedValue(mockDocs);

    // 4a. English: "show my lab reports"
    const labResult = await chatService.sendMessage({
      userId: "user-filter-type",
      question: "show my lab reports",
      sessionId: "session-filter-type",
    });
    expect(labResult.mode).toBe("STRUCTURED_LIST");
    expect(labResult.reply.items).toHaveLength(1);
    expect(labResult.reply.items[0].id).toBe("doc-lab-1");
    expect(labResult.reply.items[0].documentType).toBe("LAB_REPORT");
    expect(labResult.reply.pagination.totalRecords).toBe(1);

    // 4b. Gujarati: "મારા પ્રિસ્ક્રિપ્શન બતાવો"
    const rxResultGuj = await chatService.sendMessage({
      userId: "user-filter-type",
      question: "મારા પ્રિસ્ક્રિપ્શન બતાવો",
      sessionId: "session-filter-type",
    });
    expect(rxResultGuj.mode).toBe("STRUCTURED_LIST");
    expect(rxResultGuj.reply.items).toHaveLength(1);
    expect(rxResultGuj.reply.items[0].id).toBe("doc-rx-1");
    expect(rxResultGuj.reply.items[0].documentType).toBe("PRESCRIPTION");

    // 4c. Hindi: "मेरी लैब रिपोर्ट दिखाएं"
    const labResultHin = await chatService.sendMessage({
      userId: "user-filter-type",
      question: "मेरी लैब रिपोर्ट दिखाएं",
      sessionId: "session-filter-type",
    });
    expect(labResultHin.mode).toBe("STRUCTURED_LIST");
    expect(labResultHin.reply.items).toHaveLength(1);
    expect(labResultHin.reply.items[0].id).toBe("doc-lab-1");
  });

  test("5. Document listing filtered by OCR status across languages (failed, rejected, completed, pending)", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-filter-status",
      firstName: "Test",
      lastName: "User",
      preferredLanguage: "english",
    });

    jest
      .spyOn(chatSessionRepository, "findSessionById")
      .mockResolvedValue({ id: "session-filter-status" });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-filter-status",
      ...msg,
    }));

    const mockDocs = [
      {
        id: "doc-ok-1",
        fileName: "report_done.pdf",
        documentType: "LAB_REPORT",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-10"),
        ocrStatus: "completed",
        remarks: null,
      },
      {
        id: "doc-fail-1",
        fileName: "report_bad.pdf",
        documentType: "LAB_REPORT",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-11"),
        ocrStatus: "failed",
        remarks: null,
      },
      {
        id: "doc-cancel-1",
        fileName: "report_rejected.pdf",
        documentType: "IMAGING_REPORT",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-12"),
        ocrStatus: "canceled",
        remarks: null,
      },
      {
        id: "doc-pend-1",
        fileName: "report_waiting.pdf",
        documentType: "PRESCRIPTION",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-13"),
        ocrStatus: "pending",
        remarks: null,
      },
    ];
    jest.spyOn(documentRepository, "getSummaryByUserId").mockResolvedValue(mockDocs);

    // 5a. English: "list of failed documents"
    const failedResult = await chatService.sendMessage({
      userId: "user-filter-status",
      question: "list of failed documents",
      sessionId: "session-filter-status",
    });
    expect(failedResult.mode).toBe("STRUCTURED_LIST");
    expect(failedResult.reply.items.length).toBeGreaterThanOrEqual(1);
    expect(failedResult.reply.items.some((i) => i.id === "doc-fail-1")).toBe(true);
    expect(
      failedResult.reply.items.every((i) => ["failed", "canceled"].includes(i.ocrStatus)),
    ).toBe(true);

    // 5b. Gujarati: "રિજેક્ટ થયેલા દસ્તાવેજો બતાવો"
    const rejectedGuj = await chatService.sendMessage({
      userId: "user-filter-status",
      question: "રિજેક્ટ થયેલા દસ્તાવેજો બતાવો",
      sessionId: "session-filter-status",
    });
    expect(rejectedGuj.mode).toBe("STRUCTURED_LIST");
    expect(
      rejectedGuj.reply.items.some((i) => i.id === "doc-cancel-1" || i.id === "doc-fail-1"),
    ).toBe(true);

    // 5c. Hindi: "सफल दस्तावेज दिखाएं"
    const completedHin = await chatService.sendMessage({
      userId: "user-filter-status",
      question: "सफल दस्तावेज दिखाएं",
      sessionId: "session-filter-status",
    });
    expect(completedHin.mode).toBe("STRUCTURED_LIST");
    expect(completedHin.reply.items).toHaveLength(1);
    expect(completedHin.reply.items[0].id).toBe("doc-ok-1");
    expect(completedHin.reply.items[0].ocrStatus).toBe("completed");

    // 5d. Pending: "pending documents"
    const pendingResult = await chatService.sendMessage({
      userId: "user-filter-status",
      question: "pending documents",
      sessionId: "session-filter-status",
    });
    expect(pendingResult.mode).toBe("STRUCTURED_LIST");
    expect(pendingResult.reply.items).toHaveLength(1);
    expect(pendingResult.reply.items[0].id).toBe("doc-pend-1");
    expect(pendingResult.reply.items[0].ocrStatus).toBe("pending");
  });

  test("6. Document listing filtered by both document type and status (e.g. failed lab reports)", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-filter-both",
      firstName: "Test",
      lastName: "User",
      preferredLanguage: "english",
    });

    jest
      .spyOn(chatSessionRepository, "findSessionById")
      .mockResolvedValue({ id: "session-filter-both" });
    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-filter-both",
      ...msg,
    }));

    const mockDocs = [
      {
        id: "doc-lab-ok",
        fileName: "lab_success.pdf",
        documentType: "LAB_REPORT",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-10"),
        ocrStatus: "completed",
        remarks: null,
      },
      {
        id: "doc-lab-fail",
        fileName: "lab_error.pdf",
        documentType: "LAB_REPORT",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-11"),
        ocrStatus: "failed",
        remarks: null,
      },
      {
        id: "doc-rx-fail",
        fileName: "rx_error.pdf",
        documentType: "PRESCRIPTION",
        fileType: "application/pdf",
        reportDate: new Date("2026-05-12"),
        ocrStatus: "failed",
        remarks: null,
      },
    ];
    jest.spyOn(documentRepository, "getSummaryByUserId").mockResolvedValue(mockDocs);

    // "failed lab reports" -> Only doc-lab-fail should match
    const result = await chatService.sendMessage({
      userId: "user-filter-both",
      question: "failed lab reports",
      sessionId: "session-filter-both",
    });
    expect(result.mode).toBe("STRUCTURED_LIST");
    expect(result.reply.items).toHaveLength(1);
    expect(result.reply.items[0].id).toBe("doc-lab-fail");
    expect(result.reply.items[0].documentType).toBe("LAB_REPORT");
    expect(result.reply.items[0].ocrStatus).toBe("failed");
  });
});
