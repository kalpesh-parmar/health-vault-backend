const { chatFastPath } = require("../../src/services/ai/chat/chatFastPath.service");
const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const occurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/chatSessionRepository");

describe("10 Core Reminder Questions & Status Engine Suite", () => {
  const mockUserId = "usr-rem-suite-1";
  const mockSessionId = "sess-rem-suite-1";

  // Sample medications for detail lookups
  const sampleMedications = [
    {
      id: "med-1",
      medicationName: "Metformin",
      dosePerIntake: "500",
      unit: "mg",
      frequency: "Once daily",
      foodFrequency: "Before food",
      medicationSchedule: { morning: "09:00" },
      status: "ACTIVE",
      ongoing: true,
    },
    {
      id: "med-2",
      medicationName: "Amoxicillin",
      dosePerIntake: "250",
      unit: "mg",
      frequency: "Twice daily",
      foodFrequency: "After meal",
      medicationSchedule: { afternoon: "14:00" },
      status: "ACTIVE",
      ongoing: true,
    },
    {
      id: "med-3",
      medicationName: "Atorvastatin",
      dosePerIntake: "10",
      unit: "mg",
      frequency: "Once daily",
      foodFrequency: "At bedtime",
      medicationSchedule: { night: "21:00" },
      status: "ACTIVE",
      ongoing: true,
    },
    {
      id: "med-4",
      medicationName: "Vitamin D",
      dosePerIntake: "1000",
      unit: "IU",
      frequency: "Once daily",
      foodFrequency: "With meal",
      medicationSchedule: { morning: "08:00" },
      status: "ACTIVE",
      ongoing: true,
    },
  ];

  // 4 Sample occurrences:
  // 1: Metformin - Taken (COMPLETED)
  // 2: Amoxicillin - Missed (PENDING + isOverdue: true)
  // 3: Atorvastatin - Pending (PENDING + isOverdue: false)
  // 4: Vitamin D - Taken (COMPLETED + isOverdue: true -> must remain TAKEN, NOT MISSED)
  const sampleOccurrences = [
    {
      id: "occ-1",
      reminderId: "rem-1",
      medicationId: "med-1",
      medicationName: "Metformin",
      actualMedicationTime: new Date(new Date().setHours(9, 0, 0, 0)),
      status: "COMPLETED",
      isOverdue: false,
    },
    {
      id: "occ-2",
      reminderId: "rem-2",
      medicationId: "med-2",
      medicationName: "Amoxicillin",
      actualMedicationTime: new Date(new Date().setHours(14, 0, 0, 0)),
      status: "PENDING",
      isOverdue: true,
    },
    {
      id: "occ-3",
      reminderId: "rem-3",
      medicationId: "med-3",
      medicationName: "Atorvastatin",
      actualMedicationTime: new Date(new Date().setHours(21, 0, 0, 0)),
      status: "PENDING",
      isOverdue: false,
    },
    {
      id: "occ-4",
      reminderId: "rem-4",
      medicationId: "med-4",
      medicationName: "Vitamin D",
      actualMedicationTime: new Date(new Date().setHours(8, 0, 0, 0)),
      status: "COMPLETED",
      isOverdue: true, // Key OCCUR-01 edge-case: completed dose marked overdue is still TAKEN
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    medicationRepository.findAll.mockResolvedValue(sampleMedications);
    occurrenceRepository.findTodayOccurrences.mockResolvedValue(sampleOccurrences);
    occurrenceRepository.findAllOccurrences.mockResolvedValue(sampleOccurrences);
    occurrenceRepository.findOccurrencesByDate.mockResolvedValue([]);
    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: "msg-" + Math.random(),
      ...msg,
    }));
  });

  // 1. What are my medication reminders?
  test("1. 'What are my medication reminders?' returns full reminder schedule with counts", async () => {
    const query = "What are my medication reminders?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");
    expect(classification.entities.reminderFacet.type).toBe("all");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    expect(res.reply).toContain("Today's Medication Reminders:");
    expect(res.reply).toContain("Total Scheduled Doses:** 4");
    expect(res.reply).toContain("Taken:** 2");
    expect(res.reply).toContain("Pending:** 1");
    expect(res.reply).toContain("Missed:** 1");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Atorvastatin");
    expect(res.reply).toContain("Vitamin D");
  });

  // 2. Show my medicine reminders.
  test("2. 'Show my medicine reminders.' routes to reminders and returns schedule", async () => {
    const query = "Show my medicine reminders.";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);
    expect(res.reply).toContain("Today's Medication Reminders:");
    expect(res.reply).toContain("Total Scheduled Doses:** 4");
  });

  // 3. What are today's reminders?
  test("3. 'What are today's reminders?' returns today's reminder schedule", async () => {
    const query = "What are today's reminders?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);
    expect(res.reply).toContain("Today's Medication Reminders:");
    expect(res.reply).toContain("Taken:** 2");
  });

  // 4. What do I need to take today?
  test("4. 'What do I need to take today?' returns only pending doses with instructions", async () => {
    const query = "What do I need to take today?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");
    expect(classification.entities.reminderFacet.type).toBe("need_to_take");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    expect(res.reply).toContain("Medications to Take Today:");
    expect(res.reply).toContain("Atorvastatin");
    expect(res.reply).toContain("Pending");
    // Should NOT contain already taken doses (Metformin, Vitamin D)
    expect(res.reply).not.toContain("Metformin");
    expect(res.reply).not.toContain("Vitamin D");
  });

  // 5. What are my reminders for tomorrow?
  test("5. 'What are my reminders for tomorrow?' returns tomorrow's reminders or active schedule", async () => {
    const query = "What are my reminders for tomorrow?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");
    expect(classification.entities.reminderFacet.type).toBe("tomorrow");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);
    expect(res.reply).toContain("Tomorrow's Medication Reminders:");
    expect(res.reply).toContain("Metformin");
  });

  // 6. Did I miss any reminders today?
  test("6. 'Did I miss any reminders today?' returns missed reminders", async () => {
    const query = "Did I miss any reminders today?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");
    expect(classification.entities.reminderFacet.type).toBe("missed");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    expect(res.reply).toContain("Missed Medication Reminders:");
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Missed");
    // Taken doses must NOT be shown as missed
    expect(res.reply).not.toContain("Metformin");
    expect(res.reply).not.toContain("Vitamin D");
    expect(res.reply).not.toContain("Atorvastatin");
  });

  // 7. Show my overdue reminders.
  test("7. 'Show my overdue reminders.' returns only overdue un-taken reminders", async () => {
    const query = "Show my overdue reminders.";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");
    expect(classification.entities.reminderFacet.type).toBe("overdue");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    expect(res.reply).toContain("Overdue Medication Reminders:");
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Missed");
    expect(res.reply).not.toContain("Vitamin D"); // Vitamin D was taken, so not overdue
  });

  // 8. What are my missed reminders? (Zero missed case)
  test("8. 'What are my missed reminders?' returns clean negative message when none missed", async () => {
    // When no missed occurrences exist
    occurrenceRepository.findTodayOccurrences.mockResolvedValue([
      {
        id: "occ-1",
        medicationName: "Metformin",
        actualMedicationTime: new Date(new Date().setHours(9, 0, 0, 0)),
        status: "COMPLETED",
        isOverdue: false,
      },
    ]);
    occurrenceRepository.findAllOccurrences.mockResolvedValue([
      {
        id: "occ-1",
        medicationName: "Metformin",
        actualMedicationTime: new Date(new Date().setHours(9, 0, 0, 0)),
        status: "COMPLETED",
        isOverdue: false,
      },
    ]);

    const query = "What are my missed reminders?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.entities.reminderFacet.type).toBe("missed");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);
    expect(res.reply).toBe("You have no missed medication reminders.");
  });

  // 9. What is my next reminder?
  test("9. 'What is my next reminder?' returns strictly the single next reminder", async () => {
    const query = "What is my next reminder?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");
    expect(classification.entities.reminderFacet.type).toBe("next");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    expect(res.reply).toContain("Next Medication Reminder:");
    // Should return either the next un-taken dose (Atorvastatin or earliest untaken)
    expect(res.reply).toContain("• **");
    // Should NOT dump all 4 medications
    expect(res.reply).not.toContain("Total Scheduled Doses");
  });

  // 10. Do I have a reminder at 9 AM?
  test("10. 'Do I have a reminder at 9 AM?' returns matching reminder at 9 AM", async () => {
    const query = "Do I have a reminder at 9 AM?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");
    expect(classification.entities.reminderFacet.type).toBe("specific_time");
    expect(classification.entities.reminderFacet.time.hour).toBe(9);

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    expect(res.reply).toContain("Medication Reminders at 9:00 AM:");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).toContain("Taken");
    // Does NOT contain 2 PM or 9 PM meds
    expect(res.reply).not.toContain("Amoxicillin");
    expect(res.reply).not.toContain("Atorvastatin");
  });

  // 10b. Specific time negative match: Do I have a reminder at 11 AM?
  test("10b. Specific time query with no match returns clean negative message", async () => {
    const query = "Do I have a reminder at 11 AM?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.entities.reminderFacet.type).toBe("specific_time");
    expect(classification.entities.reminderFacet.time.hour).toBe(11);

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);
    expect(res.reply).toBe("You have no reminders scheduled at 11:00 AM.");
  });

  // 11. OCCUR-01 & OCCUR-02: Taken dose is never counted as missed; Overdue untaken is missed
  test("11. Status Integrity: Vitamin D with isOverdue=true and status=COMPLETED is TAKEN, not missed", async () => {
    const query = "What are my medication reminders?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    // Vitamin D must be TAKEN (counted as Taken: 2, and rendered with status Taken)
    expect(res.reply).toContain("Taken:** 2");
    expect(res.reply).toContain("**Vitamin D** at 8:00 AM - Taken");
    // Amoxicillin must be MISSED
    expect(res.reply).toContain("**Amoxicillin** at 2:00 PM - Missed");
  });

  // 12. OCCUR-03: Conservation: Total = Taken + Pending + Missed
  test("12. Conservation: Total (4) = Taken (2) + Pending (1) + Missed (1)", async () => {
    const query = "What are today's reminders?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);

    const totalMatch = res.reply.match(/Total Scheduled Doses:\*\*\s*(\d+)/);
    const takenMatch = res.reply.match(/Taken:\*\*\s*(\d+)/);
    const pendingMatch = res.reply.match(/Pending:\*\*\s*(\d+)/);
    const missedMatch = res.reply.match(/Missed:\*\*\s*(\d+)/);

    expect(totalMatch).not.toBeNull();
    const total = parseInt(totalMatch[1], 10);
    const taken = parseInt(takenMatch[1], 10);
    const pending = parseInt(pendingMatch[1], 10);
    const missed = parseInt(missedMatch[1], 10);

    expect(total).toBe(4);
    expect(taken).toBe(2);
    expect(pending).toBe(1);
    expect(missed).toBe(1);
    expect(taken + pending + missed).toBe(total);
  });

  // 13. Multilingual Support across Gujarati, Hindi, Marathi, Tamil
  describe("Multilingual Reminder Queries", () => {
    // Gujarati
    test("Gujarati: 'મારા દવાના રિમાઇન્ડર શું છે?' returns localized reminders", async () => {
      const raw = "મારા દવાના રિમાઇન્ડર શું છે?";
      const eng = "What are my medication reminders?";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "gujarati",
      });
      expect(classification.fastPathType).toBe("REMINDER_OCCURRENCE");

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "gujarati",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("આજના દવાના રિમાઇન્ડર્સ:");
      expect(res.reply).toContain("કુલ નિર્ધારિત ડોઝ:** 4");
      expect(res.reply).toContain("લીધેલ:** 2");
    });

    test("Gujarati: 'શું હું આજે કોઈ રિમાઇન્ડર ચૂકી ગયો?' returns missed reminders in Gujarati", async () => {
      const raw = "શું હું આજે કોઈ રિમાઇન્ડર ચૂકી ગયો?";
      const eng = "Did I miss any reminders today?";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "gujarati",
      });
      expect(classification.entities.reminderFacet.type).toBe("missed");

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "gujarati",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("ચૂકી ગયેલા દવાના રિમાઇન્ડર્સ:");
      expect(res.reply).toContain("Amoxicillin");
    });

    // Hindi
    test("Hindi: 'छूटे हुए रिमाइंडर दिखाएं' returns missed reminders in Hindi", async () => {
      const raw = "छूटे हुए रिमाइंडर दिखाएं";
      const eng = "Show missed reminders";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "hindi",
      });
      expect(classification.entities.reminderFacet.type).toBe("missed");

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "hindi",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("छूटे हुए दवा रिमाइंडर:");
      expect(res.reply).toContain("Amoxicillin");
    });

    test("Hindi: 'अगला रिमाइंडर कौन सा है?' returns next reminder in Hindi", async () => {
      const raw = "अगला रिमाइंडर कौन सा है?";
      const eng = "What is the next reminder?";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "hindi",
      });
      expect(classification.entities.reminderFacet.type).toBe("next");

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "hindi",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("अगला दवा रिमाइंडर:");
    });

    // Marathi
    test("Marathi: 'चुकलेले रिमाइंडर दाखवा' returns missed reminders in Marathi", async () => {
      const raw = "चुकलेले रिमाइंडर दाखवा";
      const eng = "Show missed reminders";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "marathi",
      });
      expect(classification.entities.reminderFacet.type).toBe("missed");

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "marathi",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("चुकलेले औषध स्मरणपत्रे:");
    });

    test("Marathi: '९ वाजता रिमाइंडर आहे का?' returns 9 AM reminder in Marathi", async () => {
      const raw = "९ वाजता रिमाइंडर आहे का?";
      const eng = "Is there a reminder at 9?";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "marathi",
      });
      expect(classification.entities.reminderFacet.type).toBe("specific_time");
      expect(classification.entities.reminderFacet.time.hour).toBe(9);

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "marathi",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("Metformin");
    });

    // Tamil
    test("Tamil: 'தவறிய நினைவூட்டல்களைக் காட்டு' returns missed reminders in Tamil", async () => {
      const raw = "தவறிய நினைவூட்டல்களைக் காட்டு";
      const eng = "Show missed reminders";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "tamil",
      });
      expect(classification.entities.reminderFacet.type).toBe("missed");

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "tamil",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("தவறிய மருந்து நினைவூட்டல்கள்:");
      expect(res.reply).toContain("Amoxicillin");
    });

    test("Tamil: 'அடுத்த நினைவூட்டல் என்ன?' returns next reminder in Tamil", async () => {
      const raw = "அடுத்த நினைவூட்டல் என்ன?";
      const eng = "What is the next reminder?";
      const classification = chatClassifier.classify({
        rawQuestion: raw,
        englishQuestion: eng,
        detectedLanguage: "tamil",
      });
      expect(classification.entities.reminderFacet.type).toBe("next");

      const ctx = {
        userId: mockUserId,
        sessionId: mockSessionId,
        question: raw,
        detectedLanguage: "tamil",
      };
      const res = await chatFastPath.execute(ctx, classification);
      expect(res.reply).toContain("அடுத்த மருந்து நினைவூட்டல்:");
    });
  });
});
