const { chatService } = require("../../src/services/ai/chat/chat.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const occurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../src/repositories/notificationRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const { ollamaClient } = require("../../src/clients/ollamaClient");

jest.mock("../../src/configs/db", () => {
  const queryMock = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: jest.fn(() => queryMock),
    },
  };
});

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/notificationRepository");
jest.mock("../../src/repositories/chatSessionRepository");
jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/repositories/userOnboardingRepository");
jest.mock("../../src/clients/ollamaClient");

jest.mock("../../src/services/ai/clients/aiClient.service", () => ({
  detectLanguage: jest.fn(async (text) => {
    if (/[\u0A80-\u0AFF]/.test(text)) return "gujarati";
    if (/[\u0900-\u097F]/.test(text)) {
      if (
        text.includes("आहे") ||
        text.includes("काय") ||
        text.includes("काल") ||
        text.includes("नाही")
      )
        return "marathi";
      return "hindi";
    }
    if (/[\u0B80-\u0BFF]/.test(text)) return "tamil";
    return "english";
  }),
  translate: jest.fn(async (text) => {
    if (text.includes("દવાઓ") && text.includes("પ્રોફાઇલ"))
      return "Show my profile and what medicines am I taking";
    if (text.includes("दवाइयों") && text.includes("प्रोफाइल"))
      return "Show my profile and my medicines";
    if (text.includes("औषधे") && text.includes("प्रोफाइल"))
      return "Show my profile and my medicines";
    if (text.includes("மருந்து") && text.includes("சுயவிவர"))
      return "Show my profile and my medicines";
    if (text.includes("જન્મ તારીખ")) return "What is my date of birth?";
    if (text.includes("નામ") || text.includes("नाम")) return "What is my name?";
    if (text.includes("રક્તગટ") || text.includes("रक्तगट")) return "What is my blood group?";
    if (text.includes("ஒவ்வாமை")) return "What are my allergies?";
    if (text.includes("દવાઓ") || text.includes("दवाइयां"))
      return "How many medicines do I need to take?";
    if (text.includes("કાલ") || text.includes("काल")) return "Which medicine did I miss yesterday?";
    if (text.includes("இருப்பு")) return "What is my medicine stock?";
    if (text.includes("સૂચના") || text.includes("सूचना"))
      return "Do I have any unread notifications?";
    return text;
  }),
}));

describe("Universal Multilingual Chat Matrix (6 Domains × 5 Languages)", () => {
  const mockUserId = "usr-matrix-999";
  const mockSessionId = "sess-matrix-999";

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
      firstName: "Ramesh",
      lastName: "Patel",
      fullName: "Ramesh Patel",
      userName: "rameshp",
      email: "ramesh.patel@example.com",
      mobile: "9876543210",
      dateOfBirth: new Date("1988-11-20"),
      gender: "male",
      bloodGroup: "O+",
      allergies: ["Sulfa drugs", "Pollen"],
      patientCode: "P-88899",
      preferredLanguage: "english",
    });

    documentRepository.findDocumentsByIds.mockResolvedValue([]);
    documentRepository.getSummaryByUserId.mockResolvedValue([]);

    ollamaClient.chat = jest.fn();
    ollamaClient.chatStream = jest.fn();
  });

  describe("1. PROFILE Domain across 5 Languages", () => {
    test("English: what is my blood group", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "what is my blood group",
        preferredLanguage: "english",
      });
      expect(res.reply).toContain("O+");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Gujarati: મારી જન્મ તારીખ શું છે?", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "મારી જન્મ તારીખ શું છે?",
        preferredLanguage: "gujarati",
      });
      expect(res.reply).toContain("1988-11-20");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Hindi: मेरा नाम क्या है", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "मेरा नाम क्या है",
        preferredLanguage: "hindi",
      });
      expect(res.reply).toContain("Ramesh Patel");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Marathi: माझा रक्तगट काय आहे", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "माझा रक्तगट काय आहे",
        preferredLanguage: "marathi",
      });
      expect(res.reply).toContain("O+");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Tamil: என் ஒவ்வாமை என்ன", async () => {
      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "என் ஒவ்வாமை என்ன",
        preferredLanguage: "tamil",
      });
      expect(res.reply).toContain("Sulfa drugs");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("2. DOCUMENTS Domain & 50+ Document Pagination", () => {
    test("Lists documents with pagination (50+ records)", async () => {
      const mock50Docs = Array.from({ length: 55 }, (_, i) => ({
        id: `doc-${i + 1}`,
        fileName: `report_${i + 1}.pdf`,
        documentType: i % 2 === 0 ? "lab_report" : "prescription",
        fileType: "application/pdf",
        reportDate: new Date("2026-02-01"),
        ocrStatus: "COMPLETED",
      }));
      documentRepository.getSummaryByUserId.mockResolvedValue(mock50Docs);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "list my documents",
        page: 2,
        limit: 20,
      });

      expect(res.mode).toBe("STRUCTURED_LIST");
      expect(res.reply.items).toHaveLength(20);
      expect(res.reply.pagination.totalRecords).toBe(55);
      expect(res.reply.pagination.pageNumber).toBe(2);
      expect(res.reply.pagination.totalPages).toBe(3);
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Counts uploaded documents in English", async () => {
      documentRepository.getSummaryByUserId.mockResolvedValue([
        { id: "d-1", fileName: "cbc.pdf" },
        { id: "d-2", fileName: "xray.pdf" },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "how many documents do I have?",
      });

      expect(res.reply).toContain("2");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("3. MEDICATIONS Domain", () => {
    test("English: List my medicines -> returns STRUCTURED_LIST", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "m-1",
          medicationName: "Metformin 500mg",
          dosePerIntake: "1 tablet",
          frequency: "TWICE_DAILY",
          medicationSchedule: "AFTER_MEAL",
          startDate: new Date("2026-01-01"),
          endDate: new Date("2026-12-31"),
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "List my medicines",
      });

      expect(res.mode).toBe("STRUCTURED_LIST");
      expect(res.reply.items).toHaveLength(1);
      expect(res.reply.items[0].name).toBe("Metformin 500mg");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Hindi: मुझे कितनी दवाइयां लेनी हैं -> returns count", async () => {
      medicationRepository.findAll.mockResolvedValue([
        { id: "m-1", medicationName: "Metformin" },
        { id: "m-2", medicationName: "Atorvastatin" },
        { id: "m-3", medicationName: "Aspirin" },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "मुझे कितनी दवाइयां लेनी हैं",
        preferredLanguage: "hindi",
      });

      expect(res.reply).toContain("3");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("4. REMINDERS & TEMPORAL (Today vs. Yesterday)", () => {
    test("English: Did I miss any medicine today?", async () => {
      occurrenceRepository.findTodayOccurrences.mockResolvedValue([
        {
          id: "occ-1",
          medicationName: "Metformin",
          actualMedicationTime: new Date("2026-09-23T08:00:00Z"),
          status: "TAKEN",
        },
        {
          id: "occ-2",
          medicationName: "Aspirin",
          actualMedicationTime: new Date("2026-09-23T14:00:00Z"),
          status: "MISSED",
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Did I miss any medicine today?",
      });

      expect(res.reply).not.toContain("Metformin");
      expect(res.reply).toContain("Aspirin");
      expect(res.reply).toContain("Missed");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Marathi: काल मी कोणते औषध चुकवले -> queries yesterday", async () => {
      occurrenceRepository.findOccurrencesByDate.mockResolvedValue([
        {
          id: "occ-yest",
          medicationName: "Atorvastatin",
          actualMedicationTime: "2026-09-22T20:00:00Z",
          status: "MISSED",
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "काल मी कोणते औषध चुकवले",
        preferredLanguage: "marathi",
      });

      expect(occurrenceRepository.findOccurrencesByDate).toHaveBeenCalled();
      expect(res.reply).toContain("Atorvastatin");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("5. REFILLS & STOCK", () => {
    test("English: Which medicines need a refill?", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "m-low",
          medicationName: "Insulin Glargine",
          remainingQuantity: 1,
          totalQuantity: 10,
          refillWarningThreshold: 3,
          refillCount: 0,
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Which medicines need a refill?",
      });

      expect(res.reply).toContain("Insulin Glargine");
      expect(res.reply).toMatch(/Medication(s Needing Refill| Refill Status):/);
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("Tamil: என் மருந்து இருப்பு எவ்வளவு", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "m-tam",
          medicationName: "Metformin",
          remainingQuantity: 20,
          totalQuantity: 60,
          refillWarningThreshold: 10,
          refillCount: 2,
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "என் மருந்து இருப்பு எவ்வளவு",
        preferredLanguage: "tamil",
      });

      expect(res.reply).toContain("Metformin");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("6. NOTIFICATIONS Domain", () => {
    test("Marathi: मला काही न वाचलेल्या सूचना आहेत का?", async () => {
      notificationRepository.list.mockResolvedValue([
        {
          id: "notif-1",
          title: "डॉक्टरांची भेट",
          body: "उद्या सकाळी १० वाजता",
          isRead: false,
        },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "मला काही न वाचलेल्या सूचना आहेत का?",
        preferredLanguage: "marathi",
      });

      expect(res.reply).toContain("डॉक्टरांची भेट");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    test("English: How many unread notifications do I have?", async () => {
      notificationRepository.list.mockResolvedValue([
        { id: "n-1", isRead: false },
        { id: "n-2", isRead: false },
        { id: "n-3", isRead: true },
      ]);

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "How many unread notifications do I have?",
      });

      expect(res.reply).toContain("3");
      expect(res.reply).toContain("2");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("7. Clinical Advice & Semantic RAG (Preserved LLM Routing)", () => {
    test("Clinical interaction question routes to LLM (Qwen / Ollama)", async () => {
      medicationRepository.findAll.mockResolvedValue([{ id: "m-asp", medicationName: "Aspirin" }]);

      const qwenSpy = jest.spyOn(chatService, "qwenHealthChat").mockResolvedValue({
        answer: "It is generally recommended to take aspirin with food.",
        emergency: false,
      });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Can I take aspirin with food?",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("aspirin");
    });
  });

  describe("8. Multi-Domain Questions & Universal App Context", () => {
    beforeEach(() => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "m-1",
          medicationName: "Metformin 500mg",
          dosePerIntake: "1 tablet",
          frequency: "TWICE_DAILY",
          medicationSchedule: "AFTER_MEAL",
          remainingQuantity: 5,
          totalQuantity: 30,
          refillWarningThreshold: 10,
        },
      ]);

      occurrenceRepository.findTodayOccurrences.mockResolvedValue([
        {
          id: "occ-1",
          medicationName: "Metformin 500mg",
          dosageTime: "08:00 AM",
          actualMedicationTime: new Date("2026-09-23T08:00:00Z"),
          status: "TAKEN",
        },
      ]);

      notificationRepository.list.mockResolvedValue([
        {
          id: "notif-1",
          title: "Follow-up Appointment",
          body: "Doctor appointment tomorrow at 10 AM",
          isRead: false,
        },
      ]);

      documentRepository.getSummaryByUserId.mockResolvedValue([
        {
          id: "doc-1",
          fileName: "Blood_Test_Report.pdf",
          documentType: "lab_report",
          reportDate: new Date("2026-02-01"),
        },
      ]);
    });

    test("English: PROFILE + MEDICATIONS combines context and bypasses single-domain intercepts", async () => {
      const qwenSpy = jest
        .spyOn(chatService, "qwenHealthChat")
        .mockImplementation(async (_history, _mode, _chunks, patientContextStr) => {
          expect(patientContextStr).toContain("Ramesh Patel");
          expect(patientContextStr).toContain("Metformin 500mg");
          return {
            answer: "Your name is Ramesh Patel and you are currently taking Metformin 500mg.",
            emergency: false,
          };
        });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "What is my profile information and what medicines am I taking?",
        preferredLanguage: "english",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("Ramesh Patel");
      expect(res.reply).toContain("Metformin 500mg");
    });

    test("Gujarati: મારી દવાઓ અને મારી પ્રોફાઇલ બતાવો (PROFILE + MEDICATIONS)", async () => {
      const qwenSpy = jest
        .spyOn(chatService, "qwenHealthChat")
        .mockImplementation(async (_history, _mode, _chunks, patientContextStr) => {
          expect(patientContextStr).toContain("Ramesh Patel");
          expect(patientContextStr).toContain("Metformin 500mg");
          return {
            answer: "તમારું નામ રમેશ પટેલ છે અને તમે મેટફોર્મિન લઈ રહ્યા છો.",
            emergency: false,
          };
        });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "મારી દવાઓ અને મારી પ્રોફાઇલ બતાવો",
        preferredLanguage: "gujarati",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("રમેશ પટેલ");
    });

    test("Hindi: मेरी प्रोफाइल और मेरी दवाइयों की जानकारी दें (PROFILE + MEDICATIONS)", async () => {
      const qwenSpy = jest
        .spyOn(chatService, "qwenHealthChat")
        .mockImplementation(async (_history, _mode, _chunks, patientContextStr) => {
          expect(patientContextStr).toContain("Ramesh Patel");
          expect(patientContextStr).toContain("Metformin 500mg");
          return {
            answer: "आपका नाम रमेश पटेल है और आप मेटफॉर्मिन ले रहे हैं।",
            emergency: false,
          };
        });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "मेरी प्रोफाइल और मेरी दवाइयों की जानकारी दें",
        preferredLanguage: "hindi",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("रमेश पटेल");
    });

    test("English: MEDICATIONS + REMINDERS combines active meds and dose schedules", async () => {
      const qwenSpy = jest
        .spyOn(chatService, "qwenHealthChat")
        .mockImplementation(async (_history, _mode, _chunks, patientContextStr) => {
          expect(patientContextStr).toContain("Metformin 500mg");
          expect(patientContextStr).toContain("MEDICATION REMINDERS STATUS TODAY");
          return {
            answer:
              "You take Metformin 500mg twice daily, and your morning 8:00 AM dose was taken.",
            emergency: false,
          };
        });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Show my medicines and medication reminders",
        preferredLanguage: "english",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("Metformin");
    });

    test("English: MEDICATIONS + REFILLS provides medication details and stock warning", async () => {
      const qwenSpy = jest
        .spyOn(chatService, "qwenHealthChat")
        .mockImplementation(async (_history, _mode, _chunks, patientContextStr) => {
          expect(patientContextStr).toContain("Metformin 500mg");
          expect(patientContextStr).toContain("ACTIVE PROFILE MEDICATIONS & REFILL DETAILS");
          return {
            answer:
              "You take Metformin 500mg, but you only have 5 remaining, so a refill is needed.",
            emergency: false,
          };
        });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Show my medicines and refills",
        preferredLanguage: "english",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("refill");
    });

    test("English: PROFILE + DOCUMENTS combines patient details and document records", async () => {
      documentRepository.getSummaryByUserId.mockResolvedValue([
        {
          id: "doc-1",
          fileName: "Blood_Test_Report.pdf",
          documentType: "lab_report",
          reportDate: new Date("2026-02-01"),
        },
      ]);
      documentRepository.findDocumentsByIds.mockResolvedValue([
        {
          id: "doc-1",
          fileName: "Blood_Test_Report.pdf",
          documentType: "lab_report",
          reportDate: new Date("2026-02-01"),
        },
      ]);
      const qwenSpy = jest
        .spyOn(chatService, "qwenHealthChat")
        .mockImplementation(async (_history, _mode, _chunks, patientContextStr) => {
          expect(patientContextStr).toContain("Ramesh Patel");
          expect(patientContextStr).toContain("Blood_Test_Report.pdf");
          return {
            answer: "Ramesh Patel, your uploaded document is Blood_Test_Report.pdf.",
            emergency: false,
          };
        });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Show my profile information and my uploaded reports",
        preferredLanguage: "english",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("Blood_Test_Report.pdf");
    });

    test("English: Comprehensive 4-Domain (PROFILE + MEDICATIONS + REMINDERS + NOTIFICATIONS)", async () => {
      const qwenSpy = jest
        .spyOn(chatService, "qwenHealthChat")
        .mockImplementation(async (_history, _mode, _chunks, patientContextStr) => {
          expect(patientContextStr).toContain("Ramesh Patel");
          expect(patientContextStr).toContain("Metformin 500mg");
          expect(patientContextStr).toContain("MEDICATION REMINDERS STATUS TODAY");
          expect(patientContextStr).toContain("NOTIFICATIONS SUMMARY");
          return {
            answer: "Here is your profile, medication list, reminders, and unread notifications.",
            emergency: false,
          };
        });

      const res = await chatService.sendMessage({
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Show my profile, medications, reminders, and notifications",
        preferredLanguage: "english",
      });

      expect(qwenSpy).toHaveBeenCalled();
      expect(res.reply).toContain("notifications");
    });
  });
});
