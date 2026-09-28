const { chatFastPath } = require("../../src/services/ai/chat/chatFastPath.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const occurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../src/repositories/notificationRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const authProviderRepository = require("../../src/repositories/authProviderRepository");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/notificationRepository");
jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/repositories/chatSessionRepository");
jest.mock("../../src/repositories/authProviderRepository");

describe("ChatFastPathService — Deterministic DB-backed Handlers", () => {
  const mockUserId = "usr-fast-100";
  const mockSessionId = "sess-fast-100";

  beforeEach(() => {
    jest.clearAllMocks();

    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: "msg-" + Math.random(),
      ...msg,
    }));

    patientRepository.findById.mockResolvedValue({
      id: mockUserId,
      firstName: "Kalpesh",
      lastName: "Parmar",
      fullName: "Kalpesh Parmar",
      userName: "kalpeshp",
      email: "kalpesh@example.com",
      mobile: "9876543210",
      countryCode: "+91",
      dateOfBirth: new Date("1992-04-10"),
      gender: "male",
      bloodGroup: "O+",
      allergies: ["Sulfa"],
      patientCode: "P-9999",
      preferredLanguage: "english",
    });

    authProviderRepository.findByUserId.mockResolvedValue([]);
  });

  describe("1. Specific Profile Field Handlers", () => {
    test("Returns DOB string", async () => {
      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "what is my date of birth",
        detectedLanguage: "english",
      };
      const classification = { entities: { specificField: "dateOfBirth" } };

      const res = await chatFastPath.handleSpecificProfileField(ctx, classification);
      expect(res.reply).toContain("1992-04-10");
      expect(res.mode).toBe("GENERAL_HEALTH");
    });

    test("Returns Blood Group string in Gujarati", async () => {
      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "મારું બ્લડ ગ્રુપ શું છે",
        detectedLanguage: "gujarati",
      };
      const classification = { entities: { specificField: "bloodGroup" } };

      const res = await chatFastPath.handleSpecificProfileField(ctx, classification);
      expect(res.reply).toContain("O+");
    });

    test("Returns Name in Tamil", async () => {
      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "என் பெயர் என்ன",
        detectedLanguage: "tamil",
      };
      const classification = { entities: { specificField: "name" } };

      const res = await chatFastPath.handleSpecificProfileField(ctx, classification);
      expect(res.reply).toContain("Kalpesh Parmar");
    });
  });

  describe("2. Count Handlers", () => {
    test("Counts uploaded documents", async () => {
      documentRepository.getSummaryByUserId.mockResolvedValue([
        { id: "doc-1", fileName: "cbc.pdf" },
        { id: "doc-2", fileName: "xray.pdf" },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "how many reports do I have?",
        detectedLanguage: "english",
      };
      const classification = { domains: new Set(["DOCUMENTS"]) };

      const res = await chatFastPath.handleCount(ctx, classification);
      expect(res.reply).toContain("2");
      expect(res.reply).toContain("uploaded medical document(s)");
    });

    test("Counts unread notifications in Marathi", async () => {
      notificationRepository.list.mockResolvedValue([
        { id: "n-1", isRead: false },
        { id: "n-2", isRead: true },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "माझ्याकडे किती सूचना आहेत",
        detectedLanguage: "marathi",
      };
      const classification = { domains: new Set(["NOTIFICATIONS"]) };

      const res = await chatFastPath.handleCount(ctx, classification);
      expect(res.reply).toContain("2");
      expect(res.reply).toContain("1");
    });
  });

  describe("3. Structured Medication List with Pagination", () => {
    test("Returns STRUCTURED_LIST with page metadata", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-1",
          medicationName: "Metformin",
          dosePerIntake: 1,
          frequency: "Twice a day",
          startDate: "2026-01-01",
        },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "list my medicines",
        page: 1,
        limit: 10,
      };

      const res = await chatFastPath.handleMedicationList(ctx);
      expect(res.mode).toBe("STRUCTURED_LIST");
      expect(res.reply.items).toHaveLength(1);
      expect(res.reply.items[0].name).toBe("Metformin");
      expect(res.reply.pagination.totalRecords).toBe(1);
      expect(res.reply.pagination.pageNumber).toBe(1);
    });
  });

  describe("4. Structured Document List with Filters", () => {
    test("Filters by status COMPLETED", async () => {
      documentRepository.getSummaryByUserId.mockResolvedValue([
        { id: "d-1", fileName: "done.pdf", ocrStatus: "COMPLETED", documentType: "lab_report" },
        { id: "d-2", fileName: "failed.pdf", ocrStatus: "FAILED", documentType: "lab_report" },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "show completed reports",
      };
      const classification = {
        entities: { statusFilter: "COMPLETED", typeFilter: "lab_report" },
      };

      const res = await chatFastPath.handleDocumentList(ctx, classification);
      expect(res.mode).toBe("STRUCTURED_LIST");
      expect(res.reply.items).toHaveLength(1);
      expect(res.reply.items[0].fileName).toBe("done.pdf");
      expect(res.reply.pagination.totalRecords).toBe(1);
    });
  });

  describe("5. Reminder Occurrence Handler with Dates", () => {
    test("Queries occurrences for yesterday when temporal is yesterday", async () => {
      occurrenceRepository.findOccurrencesByDate.mockResolvedValue([
        {
          id: "occ-yesterday",
          medicationName: "Aspirin",
          actualMedicationTime: "2026-09-22T09:00:00Z",
          status: "MISSED",
        },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Show me the medicine I missed yesterday",
        detectedLanguage: "english",
      };
      const classification = {
        entities: { temporal: "yesterday", targetDate: "2026-09-22" },
      };

      const res = await chatFastPath.handleReminderOccurrence(ctx, classification);
      expect(occurrenceRepository.findOccurrencesByDate).toHaveBeenCalledWith(
        mockUserId,
        "2026-09-22",
      );
      expect(res.reply).toContain("Aspirin");
      expect(res.reply).toContain("Missed");
    });

    test("Correctly counts COMPLETED doses as taken and overdue doses as missed", async () => {
      occurrenceRepository.findTodayOccurrences.mockResolvedValue([
        {
          id: "occ-1",
          medicationName: "Azithromycin",
          actualMedicationTime: "2026-09-23T08:00:00Z",
          status: "COMPLETED",
        },
        {
          id: "occ-2",
          medicationName: "Amoxicillin",
          actualMedicationTime: "2026-09-23T08:00:00Z",
          status: "COMPLETED",
        },
        {
          id: "occ-3",
          medicationName: "Cetirizin15",
          actualMedicationTime: "2026-09-23T08:00:00Z",
          status: "COMPLETED",
        },
        {
          id: "occ-4",
          medicationName: "Insulin",
          actualMedicationTime: "2026-09-23T08:00:00Z",
          status: "COMPLETED",
        },
        {
          id: "occ-5",
          medicationName: "Amoxicillin",
          actualMedicationTime: "2026-09-23T20:00:00Z",
          status: "PENDING",
        },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "What medication am i currently taking and which ones have I missed recently",
        detectedLanguage: "english",
      };
      const classification = {
        entities: { temporal: "today" },
      };

      const res = await chatFastPath.handleReminderOccurrence(ctx, classification);
      expect(res.reply).toContain("**Total Scheduled Doses:** 5");
      expect(res.reply).toContain("**Taken:** 4");
      expect(res.reply).toContain("**Pending:** 1");
      expect(res.reply).toContain("**Missed:** 0");
      expect(res.reply).toContain("Azithromycin");
      expect(res.reply).toContain("Taken");
    });

    test("Returns no reminders message when yesterday has no occurrences without falling back to active meds", async () => {
      occurrenceRepository.findOccurrencesByDate.mockResolvedValue([]);
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-1",
          medicationName: "Atorvastatin",
          ongoing: true,
        },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Yesterday doses",
        detectedLanguage: "english",
      };
      const classification = {
        entities: { temporal: "yesterday", targetDate: "2026-09-22" },
      };

      const res = await chatFastPath.handleReminderOccurrence(ctx, classification);
      expect(res.reply).toContain("no medication reminders recorded for yesterday");
      expect(res.reply).not.toContain("Today's Medication Reminders");
      expect(res.reply).not.toContain("Atorvastatin");
    });

    test("Formats medicationSchedule human-readably without raw JSON in active meds fallback", async () => {
      occurrenceRepository.findTodayOccurrences.mockResolvedValue([]);
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-1",
          medicationName: "Cetirizin15",
          dosePerIntake: 1,
          unit: "PILLS",
          frequency: "Once Daily",
          medicationSchedule: { Morning: "08:00:00" },
          ongoing: true,
        },
        {
          id: "med-2",
          medicationName: "Amoxicillin",
          dosePerIntake: 1,
          unit: "PILLS",
          frequency: "Twice Daily",
          medicationSchedule: { Morning: "08:00:00", Night: "20:00:00" },
          ongoing: true,
        },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "today medication list",
        detectedLanguage: "english",
      };
      const classification = {
        entities: { temporal: "today" },
      };

      const res = await chatFastPath.handleReminderOccurrence(ctx, classification);
      expect(res.reply).toContain("Cetirizin15");
      expect(res.reply).toContain("Morning: 08:00 AM");
      expect(res.reply).toContain("Night: 08:00 PM");
      expect(res.reply).not.toContain('{"Morning"');
      expect(res.reply).not.toContain('{"Night"');
    });
  });

  describe("6. Refill Stock Handler", () => {
    test("Identifies low stock medications", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-low",
          medicationName: "Atorvastatin",
          totalQuantity: 2,
          remainingQuantity: 2,
          refillWarningThreshold: 5,
        },
      ]);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: "Which medicines need a refill?",
        detectedLanguage: "english",
      };

      const res = await chatFastPath.handleRefillStock(ctx);
      expect(res.reply).toContain("Atorvastatin");
      expect(res.reply).toContain("remaining");
    });
  });
});
