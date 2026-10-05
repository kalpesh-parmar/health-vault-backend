const { chatFastPath } = require("../../src/services/ai/chat/chatFastPath.service");
const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const medicationRepository = require("../../src/repositories/medicationRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/chatSessionRepository");

describe("14 Core Medication Questions Suite", () => {
  const mockUserId = "usr-med-suite-1";
  const mockSessionId = "sess-med-suite-1";

  const sampleMedications = [
    {
      id: "med-1",
      medicationName: "Amoxicillin",
      dosePerIntake: "500",
      unit: "mg",
      frequency: "Twice daily",
      foodFrequency: "After meal",
      medicationSchedule: { morning: "09:00", night: "21:00" },
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-10-15"),
      ongoing: false,
      status: "ACTIVE",
    },
    {
      id: "med-2",
      medicationName: "Metformin",
      dosePerIntake: "1000",
      unit: "mg",
      frequency: "Once daily",
      foodFrequency: "Before food",
      medicationSchedule: { morning: "08:00" },
      startDate: new Date("2026-08-01"),
      endDate: null,
      ongoing: true,
      status: "ACTIVE",
    },
    {
      id: "med-3",
      medicationName: "Atorvastatin",
      dosePerIntake: "20",
      unit: "mg",
      frequency: "Once daily",
      foodFrequency: "After meal",
      medicationSchedule: { night: "22:00" },
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-06-01"),
      ongoing: false,
      status: "INACTIVE",
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    medicationRepository.findAll.mockResolvedValue(sampleMedications);
    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: "msg-" + Math.random(),
      ...msg,
    }));
  });

  // 1. What medicines am I taking?
  test("1. 'What medicines am I taking?' returns current active medications", async () => {
    const query = "What medicines am I taking?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).not.toContain("Atorvastatin");
  });

  // 2. List my medications.
  test("2. 'List my medications.' lists medications cleanly", async () => {
    const query = "List my medications.";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.execute(ctx, classification);
    expect(res.reply).toBeDefined();
  });

  // 3. Show all my medicines.
  test("3. 'Show all my medicines.' returns medications list", async () => {
    const query = "Show all my medicines.";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(["LIST_MEDICATION", "MEDICATION_FACET"]).toContain(classification.fastPathType);

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
  });

  // 4. What is my current medication?
  test("4. 'What is my current medication?' returns active medications", async () => {
    const query = "What is my current medication?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Metformin");
  });

  // 5. What medicine do I take in the morning?
  test("5. 'What medicine do I take in the morning?' filters to morning medications", async () => {
    const query = "What medicine do I take in the morning?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");
    expect(classification.entities.medicationFacet.value).toBe("morning");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).not.toContain("Atorvastatin");
  });

  // 6. What medicine do I take at night?
  test("6. 'What medicine do I take at night?' filters to night medications", async () => {
    const query = "What medicine do I take at night?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");
    expect(classification.entities.medicationFacet.value).toBe("night");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Atorvastatin");
    expect(res.reply).not.toContain("Metformin");
  });

  // 7. How many medicines am I currently taking?
  test("7. 'How many medicines am I currently taking?' returns accurate active count", async () => {
    const query = "How many medicines am I currently taking?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("COUNT");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleCount(ctx, classification);
    expect(res.reply).toContain("2 active medication(s)");
  });

  // 8. What dosage should I take?
  test("8. 'What dosage should I take?' returns dosage details", async () => {
    const query = "What dosage should I take?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");
    expect(classification.entities.medicationFacet.value).toBe("dosage");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("500 mg");
    expect(res.reply).toContain("1000 mg");
  });

  // 9. When should I take my medicines?
  test("9. 'When should I take my medicines?' returns schedule timings", async () => {
    const query = "When should I take my medicines?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.entities.medicationFacet.value).toBe("when_to_take");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Morning");
  });

  // 10. Show my active medications.
  test("10. 'Show my active medications.' returns only active medicines", async () => {
    const query = "Show my active medications.";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");
    expect(classification.entities.medicationFacet.value).toBe("active");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).not.toContain("Atorvastatin");
  });

  // 11. Show my inactive medications.
  test("11. 'Show my inactive medications.' returns inactive medicines", async () => {
    const query = "Show my inactive medications.";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");
    expect(classification.entities.medicationFacet.value).toBe("inactive");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Atorvastatin");
    expect(res.reply).not.toContain("Metformin");
  });

  // 12. What is the dose of my medicine?
  test("12. 'What is the dose of my medicine?' returns dose per intake", async () => {
    const query = "What is the dose of my medicine?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("500 mg");
  });

  // 13. Which medicines should I take before food?
  test("13. 'Which medicines should I take before food?' returns before-food medications", async () => {
    const query = "Which medicines should I take before food?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");
    expect(classification.entities.medicationFacet.value).toBe("before_food");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Metformin");
    expect(res.reply).not.toContain("Amoxicillin");
  });

  // 14. Which medicines should I take after food?
  test("14. 'Which medicines should I take after food?' returns after-food medications", async () => {
    const query = "Which medicines should I take after food?";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    expect(classification.fastPathType).toBe("MEDICATION_FACET");
    expect(classification.entities.medicationFacet.value).toBe("after_food");

    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).not.toContain("Metformin");
  });

  // 15. Stored End Date Integrity Check
  test("15. Stored End Date is returned as 2026-10-15 and Ongoing without recalculation", async () => {
    const query = "Show all my medicines.";
    const classification = chatClassifier.classify({ rawQuestion: query, englishQuestion: query });
    const ctx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: query,
      detectedLanguage: "english",
    };
    const res = await chatFastPath.handleMedicationFacet(ctx, classification);

    expect(res.reply).toContain("End Date: 2026-10-15");
    expect(res.reply).toContain("End Date: Ongoing");
  });

  // 16. Multilingual Check: Gujarati & Hindi
  test("16. Multilingual queries in Gujarati and Hindi return localized answers", async () => {
    const gujQuery = "હું સવારે કઈ દવા લઉં છું?";
    const gujClass = chatClassifier.classify({
      rawQuestion: gujQuery,
      englishQuestion: "What medicine do I take in the morning?",
    });
    const gujCtx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: gujQuery,
      detectedLanguage: "gujarati",
    };
    const gujRes = await chatFastPath.handleMedicationFacet(gujCtx, gujClass);
    expect(gujRes.reply).toContain("સવારની દવાઓ:");
    expect(gujRes.reply).toContain("Amoxicillin");

    const hindiQuery = "सुबह की दवाइयां कौन सी हैं?";
    const hindiClass = chatClassifier.classify({
      rawQuestion: hindiQuery,
      englishQuestion: "What are morning medicines?",
    });
    const hindiCtx = {
      userId: mockUserId,
      sessionId: mockSessionId,
      question: hindiQuery,
      detectedLanguage: "hindi",
    };
    const hindiRes = await chatFastPath.handleMedicationFacet(hindiCtx, hindiClass);
    expect(hindiRes.reply).toContain("सुबह की दवाइयां:");
  });
});
