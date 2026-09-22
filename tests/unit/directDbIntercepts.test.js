const { chatService } = require("../../src/services/ai/chat/chat.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const occurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../src/repositories/notificationRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const { ollamaClient } = require("../../src/clients/ollamaClient");

const { db } = require("../../src/configs/db");

jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn(),
  },
}));

function mockDbSelect(result = []) {
  const chain = {
    from: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  db.select.mockReturnValue(chain);
  return chain;
}

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/notificationRepository");
jest.mock("../../src/repositories/chatSessionRepository");
jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/repositories/userOnboardingRepository");
jest.mock("../../src/clients/ollamaClient");

describe("Direct Database Intercepts (Bypass LLM)", () => {
  const mockUserId = "usr-direct-100";
  const mockSessionId = "sess-direct-100";

  beforeEach(() => {
    jest.clearAllMocks();

    chatSessionRepository.findSessionById.mockResolvedValue({
      id: mockSessionId,
      userId: mockUserId,
    });
    chatSessionRepository.listSessions.mockResolvedValue({
      items: [{ id: mockSessionId }],
    });
    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: "msg-" + Math.random(),
      ...msg,
    }));

    patientRepository.findById.mockResolvedValue({
      id: mockUserId,
      firstName: "Arun",
      lastName: "Patel",
      fullName: "Arun Patel",
      userName: "arunp",
      email: "arun.patel@example.com",
      mobile: "9876543210",
      countryCode: "+91",
      firebaseUid: "fb-uid-999",
      dateOfBirth: new Date("1990-05-15"),
      gender: "male",
      bloodGroup: "B+",
      allergies: ["Penicillin", "Peanuts"],
      patientCode: "P-10023",
      preferredLanguage: "english",
    });

    ollamaClient.chat = jest.fn();
    ollamaClient.chatStream = jest.fn();
  });

  describe("1. Profile Intercepts (Direct DB)", () => {
    test("User asks 'what is my name' -> returns registered name without calling LLM", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "what is my name",
      });

      expect(res.reply).toContain("Arun Patel");
      expect(res.mode).toBe("GENERAL_HEALTH");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
      expect(ollamaClient.chatStream).not.toHaveBeenCalled();
    });

    test("User asks 'what is my blood group' -> returns blood group without calling LLM", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "what is my blood group",
      });

      expect(res.reply).toContain("B+");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("User asks 'what are my allergies' -> returns allergies list without calling LLM", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "what are my allergies",
      });

      expect(res.reply).toContain("Penicillin");
      expect(res.reply).toContain("Peanuts");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("User asks 'how did i log in' -> returns login method without calling LLM", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "how did i log in",
      });

      expect(res.reply).toContain("Mobile OTP");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("User asks 'show my profile details' -> returns full profile block without calling LLM", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "show my profile details",
      });

      expect(res.reply).toContain("Arun Patel");
      expect(res.reply).not.toContain("P-10023");
      expect(res.reply).toContain("arun.patel@example.com");
      expect(res.reply).toContain("B+");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("2. Reminder Intercepts (Direct DB)", () => {
    test("User asks 'what are my reminders today' -> returns today's dose schedule without calling LLM", async () => {
      occurrenceRepository.findTodayOccurrences = jest.fn().mockResolvedValue([
        {
          id: "occ-1",
          medicationName: "Metformin 500mg",
          actualMedicationTime: new Date("2026-09-21T08:00:00Z"),
          status: "TAKEN",
        },
        {
          id: "occ-2",
          medicationName: "Aspirin 75mg",
          actualMedicationTime: new Date("2026-09-21T20:00:00Z"),
          status: "PENDING",
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "what are my reminders today",
      });

      expect(res.reply).toContain("Today's Medication Reminders:");
      expect(res.reply).toContain("Total Scheduled Doses");
      expect(res.reply).toContain("Metformin 500mg");
      expect(res.reply).toContain("Aspirin 75mg");
      expect(res.ai.metadata.task).toBe("REMINDER_STATUS");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("3. Refill Intercepts (Direct DB)", () => {
    test("User asks 'how many refills do i have' -> returns refill stock status without calling LLM", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "m-1",
          medicationName: "Atorvastatin",
          remainingQuantity: 2,
          refillWarningThreshold: 5,
          refillCount: 1,
        },
        {
          id: "m-2",
          medicationName: "Lisinopril",
          remainingQuantity: 30,
          refillWarningThreshold: 5,
          refillCount: 4,
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "how many refills do i have",
      });

      expect(res.reply).toContain("Medication Refill Status:");
      expect(res.reply).toContain("Atorvastatin");
      expect(res.reply).toContain("Lisinopril");
      expect(res.ai.metadata.task).toBe("REFILL_STATUS");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("4. Notification Intercepts (Direct DB)", () => {
    test("User asks 'what are my notifications' -> returns recent notifications without calling LLM", async () => {
      notificationRepository.list = jest.fn().mockResolvedValue([
        {
          id: "n-1",
          title: "Prescription Ready",
          body: "Your prescription has been renewed.",
          isRead: false,
        },
        {
          id: "n-2",
          title: "Appointment Reminder",
          body: "Dr. Shah tomorrow at 10 AM",
          isRead: true,
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "what are my notifications",
      });

      expect(res.reply).toContain("Recent Notifications & Alerts:");
      expect(res.reply).toContain("Prescription Ready");
      expect(res.reply).toContain("Appointment Reminder");
      expect(res.ai.metadata.task).toBe("NOTIFICATION_STATUS");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("5. Conversational, Clinical, and Mixed Queries (Route to LLM with Unified Context)", () => {
    test("User asks 'can I take aspirin with food' -> does NOT return STRUCTURED_LIST, calls LLM with med context", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-1",
          medicationName: "Aspirin",
          dosePerIntake: "75",
          unit: "mg",
          foodFrequency: "after food",
        },
      ]);
      const qwenSpy = jest.spyOn(chatService, "qwenHealthChat").mockResolvedValue({
        answer: "Take Aspirin after meals.",
        emergency: false,
      });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "can I take aspirin with food",
      });

      expect(res.mode).not.toBe("STRUCTURED_LIST");
      expect(typeof res.reply).toBe("string");
      expect(res.reply).toBe("Take Aspirin after meals.");
      expect(qwenSpy).toHaveBeenCalled();
      const patientContextPassed = qwenSpy.mock.calls[0][3];
      expect(patientContextPassed).toContain("Aspirin");
    });

    test("User asks 'when should I take my medicine' -> routes to LLM with medication and reminder context", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-2",
          medicationName: "Metformin",
          dosePerIntake: "500",
          unit: "mg",
          frequency: "Twice daily",
        },
      ]);
      const qwenSpy = jest.spyOn(chatService, "qwenHealthChat").mockResolvedValue({
        answer: "Take Metformin twice daily.",
        emergency: false,
      });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "when should I take my medicine",
      });

      expect(res.mode).not.toBe("STRUCTURED_LIST");
      expect(typeof res.reply).toBe("string");
      expect(qwenSpy).toHaveBeenCalled();
      const patientContextPassed = qwenSpy.mock.calls[0][3];
      expect(patientContextPassed).toContain("Metformin");
    });

    test("User asks mixed report and reminder question -> routes to LLM with mixed context", async () => {
      mockDbSelect([
        {
          id: "doc-1",
          fileName: "glucose_report.pdf",
          documentType: "lab_report",
          reportDate: "2026-05-10",
        },
      ]);
      const { ragContextService } = require("../../src/services/ai/chat/ragContext.service");
      jest.spyOn(ragContextService, "retrieveRagContext").mockResolvedValue({
        summaryChunks: [{ text: "Fasting glucose: 110 mg/dL", docId: "doc-1" }],
        coverageStr: "",
      });
      const qwenSpy = jest.spyOn(chatService, "qwenHealthChat").mockResolvedValue({
        answer: "Consult your doctor regarding test results.",
        emergency: false,
      });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "my report shows high glucose, should I still take my evening reminder dose",
      });

      expect(res.mode).not.toBe("STRUCTURED_LIST");
      expect(typeof res.reply).toBe("string");
      expect(qwenSpy).toHaveBeenCalled();
    });
  });
});
