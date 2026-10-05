const {
  validateDateOfBirth,
  isProfileComplete,
} = require("../../src/services/ai/chat/onboarding/onboardingStateMachine");
const {
  getLocalizedResponse,
} = require("../../src/services/ai/chat/onboarding/stepResponseBuilder");
const { onboardingService } = require("../../src/services/ai/chat/onboarding.service");
const medicationService = require("../../src/services/medication.service");
const patientRepository = require("../../src/repositories/patientRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  },
  pool: {
    end: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock("../../src/services/ai/chat/chat.service", () => ({
  chatService: {
    createOnboardingSession: jest.fn().mockResolvedValue({ id: "sess-mock-123" }),
    appendMessage: jest.fn().mockResolvedValue({ id: "msg-mock-123" }),
    appendChatMessage: jest.fn().mockResolvedValue({ id: "msg-mock-123" }),
    attachDocumentToSession: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("../../src/clients/ollamaClient", () => ({
  ollamaClient: {
    chat: jest.fn().mockResolvedValue('{"value": null}'),
  },
}));

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/medicationReminderRepository");
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/userOnboardingRepository");
jest.mock("../../src/repositories/authProviderRepository");

describe("Onboarding DOB Validation & Idempotency Tests (HF-6)", () => {
  const userId = "test-user-dob-val-1";

  beforeEach(() => {
    jest.clearAllMocks();
    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT999",
      firstName: "Jane",
      lastName: "Doe",
    });
    patientRepository.updateById.mockResolvedValue({});
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-123" });
    jest.spyOn(chatSessionRepository, "createSession").mockResolvedValue({ id: "sess-123" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("1. validateDateOfBirth Timezone & Boundary Discipline", () => {
    test("Accepts valid past birth date", () => {
      const res = validateDateOfBirth("2000-01-01");
      expect(res.isValid).toBe(true);
      expect(res.reason).toBeNull();
      expect(res.normalizedDob).toBe("2000-01-01");
    });

    test("Rejects future dates with DOB_MUST_BE_PAST", () => {
      const res = validateDateOfBirth("2099-12-31");
      expect(res.isValid).toBe(false);
      expect(res.reason).toBe("DOB_MUST_BE_PAST");
    });

    test("Rejects today's date in Asia/Kolkata canonical timezone with DOB_MUST_BE_PAST", () => {
      const todayInIst = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
      }).format(new Date());

      const res = validateDateOfBirth(todayInIst);
      expect(res.isValid).toBe(false);
      expect(res.reason).toBe("DOB_MUST_BE_PAST");
    });

    test("Rejects age > 120 with DOB_AGE_LIMIT", () => {
      const res = validateDateOfBirth("1890-05-15");
      expect(res.isValid).toBe(false);
      expect(res.reason).toBe("DOB_AGE_LIMIT");
    });

    test("Rejects invalid formats", () => {
      expect(validateDateOfBirth("not-a-date").isValid).toBe(false);
      expect(validateDateOfBirth("").isValid).toBe(false);
      expect(validateDateOfBirth(null).isValid).toBe(false);
    });

    test("isProfileComplete requires valid past date of birth", () => {
      const todayInIst = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
      }).format(new Date());

      const validPatient = {
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "2000-01-01",
        gender: "female",
        mobile: "9876543210",
      };
      expect(isProfileComplete(validPatient)).toBe(true);

      const todayPatient = { ...validPatient, dateOfBirth: todayInIst };
      expect(isProfileComplete(todayPatient)).toBe(false);

      const futurePatient = { ...validPatient, dateOfBirth: "2099-01-01" };
      expect(isProfileComplete(futurePatient)).toBe(false);
    });
  });

  describe("2. Localized DOB Rejection Messages Across 5 Supported Languages", () => {
    const supportedLanguages = [
      { lang: "english", mustBePast: "Date of birth must be in the past" },
      { lang: "gujarati", mustBePast: "જન્મ તારીખ ભૂતકાળની હોવી જોઈએ" },
      { lang: "hindi", mustBePast: "जन्म तिथि पिछली तारीख होनी चाहिए" },
      { lang: "marathi", mustBePast: "जन्म तारीख ही भूतकाळातील असणे आवश्यक आहे" },
      { lang: "tamil", mustBePast: "பிறந்த தேதி கடந்த கால தேதியாக இருக்க வேண்டும்" },
    ];

    test.each(supportedLanguages)(
      "Returns explicit localized rejection for $lang when DOB is today or future",
      async ({ lang, mustBePast }) => {
        const state = {
          preferredLanguage: lang,
          dobRejectedReason: "DOB_MUST_BE_PAST",
        };

        const response = await getLocalizedResponse("ASK_DOB", state);
        expect(response.action).toBe("ASK_DOB");
        expect(response.isRejected).toBe(true);
        expect(response.rejectionReason).toBe("DOB_MUST_BE_PAST");
        expect(response.message).toContain(mustBePast);
      },
    );

    test("Returns maxAgeExceeded message when age > 120", async () => {
      const state = {
        preferredLanguage: "english",
        dobRejectedReason: "DOB_AGE_LIMIT",
      };

      const response = await getLocalizedResponse("ASK_DOB", state);
      expect(response.action).toBe("ASK_DOB");
      expect(response.isRejected).toBe(true);
      expect(response.rejectionReason).toBe("DOB_AGE_LIMIT");
      expect(response.message).toContain("120 years");
    });
  });

  describe("3. Onboarding Service Flow & Step Progression", () => {
    test("Submitting today's date returns isRejected: true and does not advance step", async () => {
      const todayInIst = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
      }).format(new Date());

      const state = {
        chatSessionId: "sess-mock-123",
        currentStep: "ASK_DOB",
        preferredLanguage: "english",
        existingUserData: { firstName: "Jane", lastName: "Doe" },
      };

      const res = await onboardingService.chat(todayInIst, [], state, userId);
      expect(res.action).toBe("ASK_DOB");
      expect(res.isRejected).toBe(true);
      expect(res.rejectionReason).toBe("DOB_MUST_BE_PAST");
      expect(res.message).toContain("Date of birth must be in the past");
      // Must not update patient DOB in DB with today's date
      expect(patientRepository.updateById).not.toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ dateOfBirth: expect.anything() }),
      );
    });

    test("Submitting valid past date advances to ASK_GENDER", async () => {
      const state = {
        chatSessionId: "sess-mock-123",
        currentStep: "ASK_DOB",
        preferredLanguage: "english",
        existingUserData: { firstName: "Jane", lastName: "Doe" },
      };

      const res = await onboardingService.chat("2000-01-01", [], state, userId);
      expect(res.action).toBe("ASK_GENDER");
      expect(res.isRejected).toBeFalsy();
      expect(patientRepository.updateById).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ dateOfBirth: expect.anything() }),
      );
    });
  });

  describe("4. Idempotency & Duplicate Submission Safety", () => {
    test("Duplicate CONFIRM_MEDICINES request does not call bulkCreate again", async () => {
      const state = {
        chatSessionId: "sess-mock-123",
        preferredLanguage: "english",
        currentStep: "REVIEW_MEDICINES_LIST",
        medicinesConfirmed: true,
        medicinesSavedToDb: true,
        medicationFlowDone: true,
        medicinesToAdd: [],
      };

      const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate");
      const confirmPayload = JSON.stringify({ action: "CONFIRM" });

      const res = await onboardingService.chat(confirmPayload, [], state, userId);
      expect(bulkCreateSpy).not.toHaveBeenCalled();
      expect(res.action).toBe("MEDICINE_OPTIONS");
    });

    test("Duplicate SAVE_AND_REVIEW during active onboarding does not write to DB", async () => {
      const state = {
        chatSessionId: "sess-mock-123",
        preferredLanguage: "english",
        currentStep: "ADD_MEDICINE",
        medicinesToAdd: [
          { name: "Paracetamol", dosage: "500mg", frequency: "Daily", selected: true },
        ],
      };

      const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate");
      const savePayload = JSON.stringify({ action: "SAVE_AND_REVIEW" });

      const res1 = await onboardingService.chat(savePayload, [], state, userId);
      expect(bulkCreateSpy).not.toHaveBeenCalled();
      expect(res1.action).toBe("REVIEW_MEDICINES_LIST");

      const res2 = await onboardingService.chat(savePayload, [], res1.state, userId);
      expect(bulkCreateSpy).not.toHaveBeenCalled();
      expect(res2.action).toBe("REVIEW_MEDICINES_LIST");
    });
  });
});
