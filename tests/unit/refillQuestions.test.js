const { chatFastPath } = require("../../src/services/ai/chat/chatFastPath.service");
const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const medicationRepository = require("../../src/repositories/medicationRepository");
const refillRepository = require("../../src/repositories/refillRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/refillRepository");
jest.mock("../../src/repositories/chatSessionRepository");

describe("10 Core Medication Refill Questions Suite", () => {
  const mockUserId = "usr-refill-suite-1";
  const mockSessionId = "sess-refill-suite-1";

  const sampleMedications = [
    {
      id: "med-1",
      medicationName: "Amoxicillin",
      dosePerIntake: "500",
      unit: "tablets",
      totalQuantity: 30,
      remainingQuantity: 3,
      refillWarningThreshold: 5,
      refillCount: 1,
      status: "ACTIVE",
    },
    {
      id: "med-2",
      medicationName: "Metformin",
      dosePerIntake: "1000",
      unit: "tablets",
      totalQuantity: 60,
      remainingQuantity: 45,
      refillWarningThreshold: 10,
      refillCount: 2,
      status: "ACTIVE",
    },
    {
      id: "med-3",
      medicationName: "Atorvastatin",
      dosePerIntake: "20",
      unit: "tablets",
      totalQuantity: 30,
      remainingQuantity: 28,
      refillWarningThreshold: 5,
      refillCount: 0,
      status: "ACTIVE",
    },
  ];

  const sampleRefills = [
    {
      id: "rf-1",
      userId: mockUserId,
      medicationId: "med-2",
      medicationName: "Metformin",
      unit: "tablets",
      beforeRefillTotalQuantity: "30",
      beforeRefillRemainingQuantity: "5",
      refillQuantity: 30,
      afterRefillTotalQuantity: "60",
      afterRefillRemainingQuantity: "35",
      createdAt: new Date("2026-09-20T10:00:00Z"),
    },
    {
      id: "rf-2",
      userId: mockUserId,
      medicationId: "med-1",
      medicationName: "Amoxicillin",
      unit: "tablets",
      beforeRefillTotalQuantity: "20",
      beforeRefillRemainingQuantity: "2",
      refillQuantity: 20,
      afterRefillTotalQuantity: "40",
      afterRefillRemainingQuantity: "22",
      createdAt: new Date("2026-09-10T09:00:00Z"),
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    medicationRepository.findAll.mockResolvedValue(sampleMedications);
    refillRepository.findAllByUserId.mockResolvedValue(sampleRefills);
    refillRepository.findLatestByUserId.mockResolvedValue(sampleRefills[0]);
    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: "msg-" + Math.random(),
      ...msg,
    }));
  });

  function makeContext(question, detectedLanguage = "english") {
    return {
      userId: mockUserId,
      sessionId: mockSessionId,
      question,
      detectedLanguage,
      onChunk: null,
      abortSignal: null,
    };
  }

  test("Q1: 'Show my refills.' -> Returns stock and refill overview without N/A", async () => {
    const q = "Show my refills.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.fastPathType).toBe("REFILL_STOCK");

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res).toBeDefined();
    expect(res.reply).toMatch(/Medication Refill (Status|History):/);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q2: 'List refills.' -> Returns refill overview / records without N/A", async () => {
    const q = "List refills.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res).toBeDefined();
    expect(res.reply).not.toContain("N/A");
  });

  test("Q3: 'Which medicines need a refill?' -> Identifies low stock medications requiring refill", async () => {
    const q = "Which medicines need a refill?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.entities.refillFacet.type).toBe("need_refill");

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res).toBeDefined();
    expect(res.reply).toContain("Medications Needing Refill:");
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).toContain("3 tablets remaining");
    expect(res.reply).not.toContain("Metformin");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q4: 'Do I have any pending refills?' -> Returns low stock alerts without N/A", async () => {
    const q = "Do I have any pending refills?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.entities.refillFacet.type).toBe("need_refill");

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res.reply).toContain("Amoxicillin");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q5: 'What is my latest refill?' -> Returns strictly the single most recent refill transaction", async () => {
    const q = "What is my latest refill?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.entities.refillFacet.type).toBe("latest");

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res.reply).toContain("Latest Medication Refill:");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).toContain("+30 tablets");
    expect(res.reply).toContain("2026-09-20");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q6: 'How many refills do I have?' -> Returns accurate count of recorded refills", async () => {
    const q = "How many refills do I have?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.fastPathType).toBe("COUNT");

    const res = await chatFastPath.handleCount(ctx, classification);
    expect(res.reply).toBe("You have 2 recorded medication refill(s).");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q7: 'Which medicines were recently refilled?' -> Returns recently refilled medicine", async () => {
    const q = "Which medicines were recently refilled?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.entities.refillFacet.type).toBe("latest");

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res.reply).toContain("Metformin");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q8: 'Show my refill history.' -> Returns formatted chronological list of refills", async () => {
    const q = "Show my refill history.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.entities.refillFacet.type).toBe("history");

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res.reply).toContain("Medication Refill History:");
    expect(res.reply).toContain("1. **Metformin**: +30 tablets");
    expect(res.reply).toContain("2. **Amoxicillin**: +20 tablets");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q9: 'When was my last refill date?' -> Returns latest refill date and medication", async () => {
    const q = "When was my last refill date?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.entities.refillFacet.type).toBe("latest");

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res.reply).toContain("2026-09-20");
    expect(res.reply).toContain("Metformin");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q10: 'Do I need to refill any medication?' -> Returns alert if low stock, or positive confirmation if all stocked", async () => {
    const q = "Do I need to refill any medication?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("REFILLS")).toBe(true);
    expect(classification.entities.refillFacet.type).toBe("need_refill");

    // Case A: low stock exists
    const resWithLow = await chatFastPath.handleRefillStock(ctx, classification);
    expect(resWithLow.reply).toContain("Amoxicillin");

    // Case B: no low stock
    medicationRepository.findAll.mockResolvedValueOnce([
      {
        id: "med-2",
        medicationName: "Metformin",
        remainingQuantity: 50,
        refillWarningThreshold: 10,
        refillCount: 2,
        status: "ACTIVE",
      },
    ]);
    const resNoLow = await chatFastPath.handleRefillStock(ctx, classification);
    expect(resNoLow.reply).toBe("None of your medications currently need a refill.");
    expect(resNoLow.reply).not.toContain("N/A");
  });

  test("Q11: Zero Refill Records Behavior -> Graceful message without N/A", async () => {
    refillRepository.findAllByUserId.mockResolvedValueOnce([]);
    const q = "What is my latest refill?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    const res = await chatFastPath.handleRefillStock(ctx, classification);
    expect(res.reply).toBe("You have no recorded medication refills.");
    expect(res.reply).not.toContain("N/A");
  });

  test("Q12: Multilingual Support -> Gujarati, Hindi, Marathi, Tamil", async () => {
    // Gujarati: કઈ દવા રિફિલ કરવી પડશે?
    const gujQ = "કઈ દવા રિફિલ કરવી પડશે?";
    const gujCtx = makeContext(gujQ, "gujarati");
    const gujClass = chatClassifier.classify({
      rawQuestion: gujQ,
      englishQuestion: "which medicine needs a refill?",
      detectedLanguage: "gujarati",
    });
    expect(gujClass.domains.has("REFILLS")).toBe(true);
    const gujRes = await chatFastPath.handleRefillStock(gujCtx, gujClass);
    expect(gujRes.reply).toContain("રિફિલની જરૂર હોય તેવી દવાઓ:");
    expect(gujRes.reply).toContain("Amoxicillin");
    expect(gujRes.reply).not.toContain("N/A");

    // Hindi: क्या मुझे किसी दवा को रिफिल करने की आवश्यकता है?
    const hinQ = "क्या मुझे किसी दवा को रिफिल करने की आवश्यकता है?";
    const hinCtx = makeContext(hinQ, "hindi");
    const hinClass = chatClassifier.classify({
      rawQuestion: hinQ,
      englishQuestion: "do i need to refill any medication?",
      detectedLanguage: "hindi",
    });
    expect(hinClass.domains.has("REFILLS")).toBe(true);
    const hinRes = await chatFastPath.handleRefillStock(hinCtx, hinClass);
    expect(hinRes.reply).toContain("रिफिल की आवश्यकता वाली दवाइयां:");
    expect(hinRes.reply).toContain("Amoxicillin");
    expect(hinRes.reply).not.toContain("N/A");

    // Marathi: माझी नवीनतम रिफिल कोणती आहे?
    const marQ = "माझी नवीनतम रिफिल कोणती आहे?";
    const marCtx = makeContext(marQ, "marathi");
    const marClass = chatClassifier.classify({
      rawQuestion: marQ,
      englishQuestion: "what is my latest refill?",
      detectedLanguage: "marathi",
    });
    expect(marClass.domains.has("REFILLS")).toBe(true);
    const marRes = await chatFastPath.handleRefillStock(marCtx, marClass);
    expect(marRes.reply).toContain("नवीनतम औषध रिफिल:");
    expect(marRes.reply).toContain("Metformin");
    expect(marRes.reply).not.toContain("N/A");

    // Tamil: என்னிடம் எத்தனை மறு நிரப்பல்கள் உள்ளன?
    const tamQ = "என்னிடம் எத்தனை மறு நிரப்பல்கள் உள்ளன?";
    const tamCtx = makeContext(tamQ, "tamil");
    const tamClass = chatClassifier.classify({
      rawQuestion: tamQ,
      englishQuestion: "how many refills do i have?",
      detectedLanguage: "tamil",
    });
    expect(tamClass.domains.has("REFILLS")).toBe(true);
    expect(tamClass.fastPathType).toBe("COUNT");
    const tamRes = await chatFastPath.handleCount(tamCtx, tamClass);
    expect(tamRes.reply).toBe("உங்களிடம் 2 பதிவு செய்யப்பட்ட மருந்து மறு நிரப்பல்கள் உள்ளன.");
    expect(tamRes.reply).not.toContain("N/A");
  });
});
