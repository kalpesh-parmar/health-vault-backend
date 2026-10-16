const {
  getNextRequiredOrOptionalStep,
  computeCurrentStep,
} = require("../../src/services/ai/chat/onboarding/onboardingStateMachine");
const { onboardingService } = require("../../src/services/ai/chat/onboarding.service");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../../src/repositories/authProviderRepository");
const { chatService } = require("../../src/services/ai/chat/chat.service");

describe("Manual Onboarding Profile Confirmation Test Suite", () => {
  let dbStates = {};
  const testUserId = "test-user-manual-profile-confirmation";

  beforeEach(() => {
    jest.restoreAllMocks();
    dbStates = {};

    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: testUserId,
      firstName: "Test",
      lastName: "User",
      gender: null,
      dateOfBirth: null,
      onboardingCompleted: false,
    });

    jest.spyOn(patientRepository, "updateById").mockImplementation(async (id, data) => {
      return { id, ...data };
    });

    jest.spyOn(userOnboardingRepository, "findByUserId").mockImplementation(async (userId) => {
      return dbStates[userId] ? { data: dbStates[userId] } : null;
    });

    jest
      .spyOn(userOnboardingRepository, "updateByUserId")
      .mockImplementation(async (userId, payload) => {
        dbStates[userId] = payload.data;
        return { userId, ...payload };
      });

    jest.spyOn(userOnboardingRepository, "create").mockImplementation(async (payload) => {
      dbStates[payload.userId] = payload.data;
      return payload;
    });

    jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({
      id: "mock-msg-id-1",
      createdAt: new Date(),
    });
  });

  test("1. Manual profile entry completed -> returns RESOLVE_PROFILE_SOURCE with mode: 'CONFIRM' and profileConfirmed: false", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "ASK_GENDER",
      profileConfirmed: false,
      existingUserData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "1995-05-15",
      },
    };

    const res = await onboardingService.chat("male", [], state, testUserId);

    expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(res.mode).toBe("CONFIRM");
    expect(res.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
    expect(res.state.profileConfirmed).toBe(false);
    expect(Array.isArray(res.fields)).toBe(true);
    expect(res.fields.length).toBe(6);

    const fnField = res.fields.find((f) => f.key === "firstName");
    expect(fnField.value).toBe("Aarav");
    expect(fnField.isMismatch).toBe(false);
  });

  test("2. User confirms profile -> advances to ASK_BLOOD_GROUP with profileConfirmed: true", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      profileConfirmed: false,
      existingUserData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "1995-05-15",
        gender: "male",
      },
    };

    const res = await onboardingService.chat(
      JSON.stringify({ confirmed: true }),
      [],
      state,
      testUserId,
    );

    expect(res.action).toBe("ASK_BLOOD_GROUP");
    expect(res.state.currentStep).toBe("ASK_BLOOD_GROUP");
    expect(res.state.profileConfirmed).toBe(true);
  });

  test("3. Profile edit and confirm -> updates patient data and advances to ASK_BLOOD_GROUP", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      profileConfirmed: false,
      existingUserData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "1995-05-15",
        gender: "male",
      },
    };

    const updateSpy = jest.spyOn(patientRepository, "updateById");

    const res = await onboardingService.chat(
      JSON.stringify({
        confirmed: true,
        source: "MANUAL",
        edited: {
          firstName: "Aryan",
          lastName: "Patel",
          dateOfBirth: "1995-05-15",
          gender: "male",
        },
      }),
      [],
      state,
      testUserId,
    );

    expect(res.action).toBe("ASK_BLOOD_GROUP");
    expect(res.state.currentStep).toBe("ASK_BLOOD_GROUP");
    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.existingUserData.firstName).toBe("Aryan");

    expect(updateSpy).toHaveBeenCalledWith(
      testUserId,
      expect.objectContaining({ firstName: "Aryan" }),
    );
  });

  test("4. App restart before confirmation -> resumes at RESOLVE_PROFILE_SOURCE", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "ASK_GENDER",
      profileConfirmed: false,
      existingUserData: {
        firstName: "Pooja",
        lastName: "Shah",
        dateOfBirth: "1992-03-25",
      },
    };

    // Complete gender entry
    const res = await onboardingService.chat("female", [], state, testUserId);
    expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");

    // Persisted record before confirmation
    const persisted = dbStates[testUserId];
    expect(persisted.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
    expect(persisted.profileConfirmed).toBe(false);

    // Recompute step on fresh state restoration
    const computedStep = computeCurrentStep(persisted);
    expect(computedStep).toBe("RESOLVE_PROFILE_SOURCE");
  });

  test("5. Document mismatch -> returns RESOLVE_PROFILE_SOURCE with mode: 'CONFLICT'", async () => {
    const state = {
      flowMode: "UPLOAD",
      preferredLanguage: "english",
      loginProvider: "google",
      hasSocialData: true,
      documentUploaded: true,
      documentConfirmed: true,
      documentOwnershipConfirmed: true,
      profileConfirmed: false,
      socialData: {
        firstName: "John",
        lastName: "Doe",
      },
      documentData: {
        firstName: "Jonathan",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      existingUserData: {
        firstName: "Jonathan",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      currentStep: "RESOLVE_PROFILE_SOURCE",
    };

    const res = await onboardingService.chat("hello", [], state, testUserId);
    expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(res.mode).toBe("CONFLICT");
  });

  test("6. Already confirmed profile -> advances to ASK_BLOOD_GROUP without repeating confirmation", () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      profileConfirmed: true,
      existingUserData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "2000-01-01",
        gender: "male",
      },
    };

    const nextStep = getNextRequiredOrOptionalStep(state);
    expect(nextStep).toBe("ASK_BLOOD_GROUP");
    expect(nextStep).not.toBe("RESOLVE_PROFILE_SOURCE");
  });

  test("7. Duplicate confirmation requests -> handled idempotently without duplicate transitions", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      profileConfirmed: true,
      existingUserData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "2000-01-01",
        gender: "male",
        bloodGroup: null,
      },
    };

    // User submits confirm payload again when already confirmed
    const res = await onboardingService.chat(
      JSON.stringify({ confirmed: true }),
      [],
      state,
      testUserId,
    );

    expect(res.action).toBe("ASK_BLOOD_GROUP");
    expect(res.state.currentStep).toBe("ASK_BLOOD_GROUP");
    expect(res.state.profileConfirmed).toBe(true);
  });
});
