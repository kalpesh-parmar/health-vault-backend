const { chatFastPath } = require("../../src/services/ai/chat/chatFastPath.service");
const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const notificationRepository = require("../../src/repositories/notificationRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

jest.mock("../../src/repositories/notificationRepository");
jest.mock("../../src/repositories/chatSessionRepository");

describe("10 Core Notification Questions Suite (Multilingual Parity)", () => {
  const mockUserId = "usr-notif-suite-1";
  const mockSessionId = "sess-notif-suite-1";

  const todayStr = new Date().toISOString();
  const yesterdayStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const sampleNotifications = [
    {
      id: "notif-1",
      userId: mockUserId,
      title: "Prescription Refill Alert",
      body: "Your Metformin refill is due in 2 days.",
      isRead: false,
      priority: "urgent",
      createdAt: todayStr,
    },
    {
      id: "notif-2",
      userId: mockUserId,
      title: "Lab Results Ready",
      body: "Your CBC blood test report has been processed.",
      isRead: false,
      priority: "normal",
      createdAt: todayStr,
    },
    {
      id: "notif-3",
      userId: mockUserId,
      title: "Daily Dose Reminder",
      body: "Don't forget your 9:00 AM morning medicine.",
      isRead: true,
      priority: "normal",
      createdAt: yesterdayStr,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    notificationRepository.list.mockResolvedValue(sampleNotifications);
    chatSessionRepository.appendMessage.mockResolvedValue({ id: "msg-1" });
  });

  function classifyQuestion(question, detectedLanguage = "english") {
    return chatClassifier.classify({
      rawQuestion: question,
      englishQuestion: question,
      detectedLanguage,
    });
  }

  describe("English - 10 Core Notification Questions", () => {
    test("Q1: Show notifications", async () => {
      const question = "Show notifications";
      const classification = classifyQuestion(question);
      expect(classification.domains.has("NOTIFICATIONS")).toBe(true);

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Recent Notifications & Alerts:");
      expect(res.reply).toContain("Total Notifications");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Q2: What notifications do I have?", async () => {
      const question = "What notifications do I have?";
      const classification = classifyQuestion(question);
      expect(classification.domains.has("NOTIFICATIONS")).toBe(true);

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Recent Notifications & Alerts:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Q3: List notifications", async () => {
      const question = "List notifications";
      const classification = classifyQuestion(question);
      expect(classification.domains.has("NOTIFICATIONS")).toBe(true);

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Recent Notifications & Alerts:");
      expect(res.reply).toContain("Lab Results Ready");
    });

    test("Q4: Unread notifications", async () => {
      const question = "Unread notifications";
      const classification = classifyQuestion(question);
      expect(classification.entities.isUnreadOnly).toBe(true);

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Recent Notifications & Alerts:");
      expect(res.reply).toContain("- **Unread:** 2");
      expect(res.reply).toContain("Prescription Refill Alert");
      expect(res.reply).toContain("Lab Results Ready");
      expect(res.reply).not.toContain("Daily Dose Reminder");
    });

    test("Q5: Latest notifications", async () => {
      const question = "Latest notifications";
      const classification = classifyQuestion(question);
      expect(classification.entities.notificationFacet.type).toBe("latest");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Latest Notifications & Alerts:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Q6: What was my last notification?", async () => {
      const question = "What was my last notification?";
      const classification = classifyQuestion(question);
      expect(classification.entities.notificationFacet.type).toBe("last");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Last Notification:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Q7: Today's notifications", async () => {
      const question = "Today's notifications";
      const classification = classifyQuestion(question);
      expect(classification.entities.notificationFacet.type).toBe("today");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Today's Notifications & Alerts:");
      expect(res.reply).toContain("Prescription Refill Alert");
      expect(res.reply).toContain("Lab Results Ready");
      expect(res.reply).not.toContain("Daily Dose Reminder");
    });

    test("Q8: What is my unread notification count?", async () => {
      const question = "What is my unread notification count?";
      const classification = classifyQuestion(question);
      expect(classification.entities.notificationFacet.type).toBe("count");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toBe("You have 3 notification(s) (2 unread).");
    });

    test("Q9: Important notifications", async () => {
      const question = "Important notifications";
      const classification = classifyQuestion(question);
      expect(classification.entities.notificationFacet.type).toBe("important");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Important Notifications & Alerts:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Q10: Recent notifications", async () => {
      const question = "Recent notifications";
      const classification = classifyQuestion(question);
      expect(classification.entities.notificationFacet.type).toBe("latest");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Latest Notifications & Alerts:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });
  });

  describe("Multilingual Equivalence for Notification Facets", () => {
    test("Gujarati: Last notification (મારી છેલ્લી નોટિફિકેશન કઈ હતી?)", async () => {
      const question = "મારી છેલ્લી નોટિફિકેશન કઈ હતી?";
      const classification = classifyQuestion(question, "gujarati");
      expect(classification.entities.notificationFacet.type).toBe("last");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "gujarati" },
        classification,
      );
      expect(res.reply).toContain("છેલ્લી નોટિફિકેશન:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Hindi: Last notification (मेरी आखिरी सूचना क्या थी?)", async () => {
      const question = "मेरी आखिरी सूचना क्या थी?";
      const classification = classifyQuestion(question, "hindi");
      expect(classification.entities.notificationFacet.type).toBe("last");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "hindi" },
        classification,
      );
      expect(res.reply).toContain("आखिरी सूचना:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Marathi: Last notification (माझी शेवटची सूचना कोणती होती?)", async () => {
      const question = "माझी शेवटची सूचना कोणती होती?";
      const classification = classifyQuestion(question, "marathi");
      expect(classification.entities.notificationFacet.type).toBe("last");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "marathi" },
        classification,
      );
      expect(res.reply).toContain("शेवटची सूचना:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Tamil: Last notification (என் கடைசி அறிவிப்பு என்ன?)", async () => {
      const question = "என் கடைசி அறிவிப்பு என்ன?";
      const classification = classifyQuestion(question, "tamil");
      expect(classification.entities.notificationFacet.type).toBe("last");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "tamil" },
        classification,
      );
      expect(res.reply).toContain("கடைசி அறிவிப்பு:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });

    test("Gujarati: Unread count (મારી કેટલી નોટિફિકેશન ન વંચાયેલ છે?)", async () => {
      const question = "મારી કેટલી નોટિફિકેશન ન વંચાયેલ છે?";
      const classification = classifyQuestion(question, "gujarati");
      expect(classification.entities.notificationFacet.type).toBe("count");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "gujarati" },
        classification,
      );
      expect(res.reply).toBe("તમારી પાસે 3 નોટિફિકેશન છે (2 ન વંચાયેલ).");
    });

    test("Hindi: Today's notifications (आज की सूचनाएं)", async () => {
      const question = "आज की सूचनाएं";
      const classification = classifyQuestion(question, "hindi");
      expect(classification.entities.notificationFacet.type).toBe("today");

      const res = await chatFastPath.handleNotificationStatus(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "hindi" },
        classification,
      );
      expect(res.reply).toContain("आज की सूचनाएं:");
      expect(res.reply).toContain("Prescription Refill Alert");
    });
  });
});
