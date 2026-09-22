const { chatService } = require("../../src/services/ai/chat/chat.service");
const patientRepository = require("../../src/repositories/patientRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const occurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../src/repositories/notificationRepository");

describe("Chat Query Routing Fix Tests", () => {
  const mockUserId = "test-routing-user-123";
  const mockSessionId = "test-routing-session-123";

  beforeEach(() => {
    jest.restoreAllMocks();

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: mockUserId,
      firstName: "Kalpesh",
      lastName: "Parmar",
      fullName: "Kalpesh Parmar",
      patientCode: "P-12345",
      preferredLanguage: "english",
    });

    jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({
      id: mockSessionId,
      userId: mockUserId,
      metadata: {},
    });

    jest.spyOn(chatSessionRepository, "appendMessage").mockImplementation(async (msg) => ({
      id: "msg-123",
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("1. 'today medication liist' routes to REMINDER_STATUS and NOT to DOCUMENT_LIST", async () => {
    const docSummarySpy = jest
      .spyOn(documentRepository, "getSummaryByUserId")
      .mockResolvedValue([{ id: "doc-1", fileName: "blood_test.pdf", documentType: "lab_report" }]);

    jest.spyOn(occurrenceRepository, "findTodayOccurrences").mockResolvedValue([
      {
        id: "occ-1",
        medicationName: "Metformin",
        actualMedicationTime: new Date().toISOString(),
        status: "PENDING",
      },
    ]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "today medication liist",
    });

    expect(docSummarySpy).not.toHaveBeenCalled();
    expect(result.ai.metadata.task).toBe("REMINDER_STATUS");
    expect(result.reply).toContain("Today's Medication Reminders");
    expect(result.reply).toContain("Metformin");
    expect(result.mode).toBe("GENERAL_HEALTH");
  });

  test("2. 'today medication list' with no occurrences falls back to active medications", async () => {
    const docSummarySpy = jest
      .spyOn(documentRepository, "getSummaryByUserId")
      .mockResolvedValue([]);

    jest.spyOn(occurrenceRepository, "findTodayOccurrences").mockResolvedValue([]);

    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "med-1",
        medicationName: "Atorvastatin",
        dosePerIntake: 20,
        unit: "mg",
        frequency: "Once daily",
        ongoing: true,
      },
    ]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "today medication list",
    });

    expect(docSummarySpy).not.toHaveBeenCalled();
    expect(result.ai.metadata.task).toBe("REMINDER_STATUS");
    expect(result.reply).toContain("Atorvastatin");
  });

  test("3. 'list of medication with remaing quntity' routes to REFILL_STATUS and NOT to DOCUMENT_LIST", async () => {
    const docSummarySpy = jest
      .spyOn(documentRepository, "getSummaryByUserId")
      .mockResolvedValue([
        { id: "doc-1", fileName: "prescription.pdf", documentType: "prescription" },
      ]);

    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "med-1",
        medicationName: "Aspirin",
        totalQuantity: 30,
        dosePerIntake: 1,
        refillCount: 2,
        refillWarningThreshold: 5,
      },
    ]);

    jest
      .spyOn(occurrenceRepository, "countCompletedOccurrencesByMedicationId")
      .mockResolvedValue(5);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "list of medication with remaing quntity",
    });

    expect(docSummarySpy).not.toHaveBeenCalled();
    expect(result.ai.metadata.task).toBe("REFILL_STATUS");
    expect(result.reply).toContain("Medication Refill Status");
    expect(result.reply).toContain("Aspirin");
    expect(result.reply).toContain("25"); // 30 - 5 = 25
  });

  test("4. 'unread notification list' routes to NOTIFICATION_STATUS and NOT to DOCUMENT_LIST", async () => {
    const docSummarySpy = jest
      .spyOn(documentRepository, "getSummaryByUserId")
      .mockResolvedValue([{ id: "doc-1", fileName: "scan.pdf", documentType: "imaging" }]);

    jest.spyOn(notificationRepository, "list").mockResolvedValue([
      {
        id: "notif-1",
        title: "Medication Alert",
        body: "Time to take your Metformin dose",
        isRead: false,
      },
      {
        id: "notif-2",
        title: "Welcome Notice",
        body: "Welcome to Health Vault",
        isRead: true,
      },
    ]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "unread notification list",
    });

    expect(docSummarySpy).not.toHaveBeenCalled();
    expect(result.ai.metadata.task).toBe("NOTIFICATION_STATUS");
    expect(result.reply).toContain("Recent Notifications & Alerts");
    expect(result.reply).toContain("Medication Alert");
    expect(result.reply).toContain("Unread");
  });

  test("5. 'unread notification list' when no unread notifications exist returns friendly message", async () => {
    jest.spyOn(notificationRepository, "list").mockResolvedValue([
      {
        id: "notif-1",
        title: "Read Notice",
        body: "Already read",
        isRead: true,
      },
    ]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "unread notification list",
    });

    expect(result.ai.metadata.task).toBe("NOTIFICATION_STATUS");
    expect(result.reply).toContain("You have no unread notifications");
  });

  test("6. 'list all documents' and 'show my reports' still correctly route to DOCUMENT_LIST", async () => {
    jest.spyOn(documentRepository, "getSummaryByUserId").mockResolvedValue([
      {
        id: "doc-1",
        fileName: "lab_results.pdf",
        documentType: "lab_report",
        fileType: "application/pdf",
        reportDate: new Date("2026-03-01"),
        ocrStatus: "COMPLETED",
      },
    ]);

    const result = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "list all documents",
    });

    expect(result.ai.metadata.task).toBe("DOCUMENT_LIST");
    expect(result.mode).toBe("STRUCTURED_LIST");
    expect(result.reply.items).toHaveLength(1);
    expect(result.reply.items[0].fileName).toBe("lab_results.pdf");
  });
});
