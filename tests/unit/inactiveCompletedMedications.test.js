const { chatService } = require("../../src/services/ai/chat/chat.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

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
jest.mock("../../src/repositories/chatSessionRepository");
jest.mock("../../src/repositories/userOnboardingRepository");

jest.mock("../../src/services/ai/clients/aiClient.service", () => ({
  detectLanguage: jest.fn(async (text) => {
    if (/[\u0A80-\u0AFF]/.test(text)) return "gujarati";
    if (/[\u0900-\u097F]/.test(text)) {
      if (text.includes("औषधे") || text.includes("दाखवा")) return "marathi";
      return "hindi";
    }
    if (/[\u0B80-\u0BFF]/.test(text)) return "tamil";
    return "english";
  }),
  translate: jest.fn(async (text) => text),
}));

describe("Completed / 0-Stock Inactive Medications Filter Tests (5 Languages)", () => {
  const mockUserId = "usr-inactive-meds-123";
  const mockSessionId = "sess-inactive-meds-123";

  const sampleMedications = [
    {
      id: "med-1",
      medicationName: "Metformin 500mg",
      dosePerIntake: 1,
      unit: "tablet",
      frequency: "Twice daily",
      foodFrequency: "AFTER_FOOD",
      status: "ACTIVE",
      ongoing: true,
      remainingQuantity: 30,
      totalQuantity: 60,
    },
    {
      id: "med-2",
      medicationName: "Dolo 650mg",
      dosePerIntake: 1,
      unit: "tablet",
      frequency: "Once daily",
      foodFrequency: "AFTER_FOOD",
      status: "ACTIVE",
      ongoing: true,
      remainingQuantity: 10,
      totalQuantity: 20,
    },
    {
      id: "med-3",
      medicationName: "Pantocid 40mg",
      dosePerIntake: 1,
      unit: "capsule",
      frequency: "Once daily",
      foodFrequency: "BEFORE_FOOD",
      status: "ACTIVE",
      ongoing: true,
      remainingQuantity: 0, // Stock finished -> Completed/Inactive
      totalQuantity: 30,
    },
    {
      id: "med-4",
      medicationName: "Amoxicillin 500mg",
      dosePerIntake: 1,
      unit: "capsule",
      frequency: "Thrice daily",
      foodFrequency: "AFTER_FOOD",
      status: "COMPLETED", // Explicitly completed
      ongoing: false,
      remainingQuantity: 0,
      totalQuantity: 15,
    },
  ];

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
      firstName: "Test",
      lastName: "Patient",
      preferredLanguage: "english",
    });

    medicationRepository.findAll.mockResolvedValue(sampleMedications);
  });

  test("English: 'show my completed medications' returns ONLY the 2 0-stock/completed medications", async () => {
    const res = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "show my completed medications",
      preferredLanguage: "english",
    });

    expect(res.mode).toBe("STRUCTURED_LIST");
    expect(res.reply.items).toHaveLength(2);
    const itemNames = res.reply.items.map((i) => i.name);
    expect(itemNames).toContain("Pantocid 40mg");
    expect(itemNames).toContain("Amoxicillin 500mg");
    expect(itemNames).not.toContain("Metformin 500mg");
    expect(itemNames).not.toContain("Dolo 650mg");
  });

  test("Gujarati: 'મારી પૂરી થયેલી દવાઓ બતાવો' returns ONLY the 2 0-stock/completed medications", async () => {
    const res = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "મારી પૂરી થયેલી દવાઓ બતાવો",
      preferredLanguage: "gujarati",
    });

    expect(res.mode).toBe("STRUCTURED_LIST");
    expect(res.reply.items).toHaveLength(2);
    const itemNames = res.reply.items.map((i) => i.name);
    expect(itemNames).toContain("Pantocid 40mg");
    expect(itemNames).toContain("Amoxicillin 500mg");
  });

  test("Hindi: 'मेरी पूरी हुई दवाइयां दिखाएं' returns ONLY the 2 0-stock/completed medications", async () => {
    const res = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "मेरी पूरी हुई दवाइयां दिखाएं",
      preferredLanguage: "hindi",
    });

    expect(res.mode).toBe("STRUCTURED_LIST");
    expect(res.reply.items).toHaveLength(2);
    const itemNames = res.reply.items.map((i) => i.name);
    expect(itemNames).toContain("Pantocid 40mg");
    expect(itemNames).toContain("Amoxicillin 500mg");
  });

  test("Marathi: 'माझी संपलेली औषधे दाखवा' returns ONLY the 2 0-stock/completed medications", async () => {
    const res = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "माझी संपलेली औषधे दाखवा",
      preferredLanguage: "marathi",
    });

    expect(res.mode).toBe("STRUCTURED_LIST");
    expect(res.reply.items).toHaveLength(2);
    const itemNames = res.reply.items.map((i) => i.name);
    expect(itemNames).toContain("Pantocid 40mg");
    expect(itemNames).toContain("Amoxicillin 500mg");
  });

  test("Tamil: 'எனது முடிந்த மருந்துகளைக் காட்டு' returns ONLY the 2 0-stock/completed medications", async () => {
    const res = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "எனது முடிந்த மருந்துகளைக் காட்டு",
      preferredLanguage: "tamil",
    });

    expect(res.mode).toBe("STRUCTURED_LIST");
    expect(res.reply.items).toHaveLength(2);
    const itemNames = res.reply.items.map((i) => i.name);
    expect(itemNames).toContain("Pantocid 40mg");
    expect(itemNames).toContain("Amoxicillin 500mg");
  });

  test("English: 'show my active medications' returns ONLY the 2 medications with remaining stock > 0", async () => {
    const res = await chatService.sendMessage({
      userId: mockUserId,
      sessionId: mockSessionId,
      question: "show my active medications",
      preferredLanguage: "english",
    });

    expect(res.mode).toBe("STRUCTURED_LIST");
    expect(res.reply.items).toHaveLength(2);
    const itemNames = res.reply.items.map((i) => i.name);
    expect(itemNames).toContain("Metformin 500mg");
    expect(itemNames).toContain("Dolo 650mg");
    expect(itemNames).not.toContain("Pantocid 40mg");
    expect(itemNames).not.toContain("Amoxicillin 500mg");
  });
});
