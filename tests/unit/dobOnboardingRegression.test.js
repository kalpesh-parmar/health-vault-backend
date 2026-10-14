const {
  getNextRequiredOrOptionalStep,
  hasGenuineProfileConflict,
} = require("../../src/services/ai/chat/onboarding/onboardingStateMachine");
const { onboardingService } = require("../../src/services/ai/chat/onboarding.service");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../../src/repositories/authProviderRepository");
const { chatService } = require("../../src/services/ai/chat/chat.service");

describe("Pre-Onboarding DOB Regression & Progression Tests", () => {
  let dbStates = {};
  const testUserId = "test-user-dob-regression";

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

  test("1. Valid DOB with gender missing progresses to ASK_GENDER", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "ASK_DOB",
      existingUserData: {
        firstName: "Shradha",
        lastName: "Chauhan",
        gender: null,
      },
    };

    const res = await onboardingService.chat("1998-07-15", [], state, testUserId);
    expect(res.action).toBe("ASK_GENDER");
    expect(res.state.existingUserData.dateOfBirth).toBe("1998-07-15");
    expect(res.state.currentStep).toBe("ASK_GENDER");
  });

  test("2. Valid DOB with gender already present bypasses RESOLVE_PROFILE_SOURCE and progresses to ASK_BLOOD_GROUP", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "ASK_DOB",
      profileConfirmed: false,
      existingUserData: {
        firstName: "Shradha",
        lastName: "Chauhan",
        gender: "female",
      },
    };

    // State machine evaluation directly
    const nextStep = getNextRequiredOrOptionalStep({
      ...state,
      existingUserData: { ...state.existingUserData, dateOfBirth: "1998-07-15" },
    });
    expect(nextStep).toBe("ASK_BLOOD_GROUP");
    expect(nextStep).not.toBe("RESOLVE_PROFILE_SOURCE");

    // Full service execution
    const res = await onboardingService.chat("1998-07-15", [], state, testUserId);
    expect(res.action).toBe("ASK_BLOOD_GROUP");
    expect(res.state.currentStep).toBe("ASK_BLOOD_GROUP");
    expect(res.state.profileConfirmed).toBe(true);
  });

  test("3. Invalid DOB and retry: rejects current/future date, stays on ASK_DOB, then succeeds on retry", async () => {
    const today = new Date().toISOString().split("T")[0];
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "ASK_DOB",
      existingUserData: {
        firstName: "Shradha",
        lastName: "Chauhan",
        gender: null,
      },
    };

    // Attempt 1: Today's date (must be rejected)
    const rejRes = await onboardingService.chat(today, [], state, testUserId);
    expect(rejRes.action).toBe("ASK_DOB");
    expect(rejRes.isRejected).toBe(true);
    expect(rejRes.rejectionReason).toBe("DOB_MUST_BE_PAST");
    expect(rejRes.state.currentStep).toBe("ASK_DOB");
    expect(rejRes.state.existingUserData.dateOfBirth).toBeUndefined();

    // Attempt 2: Valid past date retry
    const validRes = await onboardingService.chat("1995-05-20", [], rejRes.state, testUserId);
    expect(validRes.action).toBe("ASK_GENDER");
    expect(validRes.state.existingUserData.dateOfBirth).toBe("1995-05-20");
    expect(validRes.state.currentStep).toBe("ASK_GENDER");
  });

  test("4. Manual onboarding without documents progresses through demographic flow without triggering RESOLVE_PROFILE_SOURCE", () => {
    const state = {
      flowMode: "MANUAL",
      documentUploaded: false,
      documentExtracted: false,
      existingUserData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "2000-01-01",
        gender: "male",
      },
    };

    expect(hasGenuineProfileConflict(state)).toBe(false);
    expect(getNextRequiredOrOptionalStep(state)).toBe("ASK_BLOOD_GROUP");
  });

  test("5. Actual document/profile conflict resolution: UPLOAD flow with extracted document triggers RESOLVE_PROFILE_SOURCE", () => {
    const state = {
      flowMode: "UPLOAD",
      documentUploaded: true,
      documentExtracted: true,
      documentOwnershipConfirmed: true,
      profileConfirmed: false,
      documentData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "1999-12-31",
        gender: "male",
      },
      existingUserData: {
        firstName: "Aarav",
        lastName: "Patel",
        dateOfBirth: "2000-01-01",
        gender: "male",
      },
    };

    expect(hasGenuineProfileConflict(state)).toBe(true);
    expect(getNextRequiredOrOptionalStep(state)).toBe("RESOLVE_PROFILE_SOURCE");
  });

  test("6. Session restart and resume: state is safely persisted and restored across turns", async () => {
    const state = {
      flowMode: "MANUAL",
      preferredLanguage: "english",
      currentStep: "ASK_DOB",
      existingUserData: {
        firstName: "Shradha",
        lastName: "Chauhan",
        gender: "female",
      },
    };

    await onboardingService.chat("1995-10-10", [], state, testUserId);

    // Verify DB received updated state
    expect(dbStates[testUserId]).toBeDefined();
    expect(dbStates[testUserId].existingUserData.dateOfBirth).toBe("1995-10-10");
    expect(dbStates[testUserId].currentStep).toBe("ASK_BLOOD_GROUP");

    // Simulate session resume
    const resumedRecord = await userOnboardingRepository.findByUserId(testUserId);
    expect(resumedRecord.data.existingUserData.dateOfBirth).toBe("1995-10-10");
    expect(resumedRecord.data.currentStep).toBe("ASK_BLOOD_GROUP");
  });

  test("7. Duplicate assistant responses: duplicate suppression exempts validation rejections and interactive prompts", () => {
    const filterDuplicate = (lastMsg, newMsg, aiRes) => {
      const isInteractiveOptionMsg =
        newMsg.action === "MEDICINE_OPTIONS" ||
        newMsg.action === "ASK_DOB" ||
        (Array.isArray(newMsg.options) && newMsg.options.length > 0);

      const isValidationRejectionMsg = Boolean(
        aiRes.isRejected ||
        aiRes.rejectionReason ||
        newMsg.isRejected ||
        newMsg.rejectionReason ||
        (newMsg.action === "ASK_DOB" && (aiRes.dobRejectedReason || aiRes.rejectionReason)),
      );

      const isDuplicate =
        !isValidationRejectionMsg &&
        !isInteractiveOptionMsg &&
        lastMsg &&
        lastMsg.action === newMsg.action &&
        lastMsg.content === newMsg.content;

      return isDuplicate;
    };

    const lastMsg = { action: "ASK_DOB", content: "What is your date of birth?" };
    const rejNewMsg = { action: "ASK_DOB", content: "Date of birth must be in the past." };
    const aiResRejected = { isRejected: true, rejectionReason: "DOB_MUST_BE_PAST" };

    // Rejection must NOT be suppressed
    expect(filterDuplicate(lastMsg, rejNewMsg, aiResRejected)).toBe(false);

    // Prompt with action ASK_DOB must NOT be suppressed as it is an interactive option prompt
    const nextDobMsg = { action: "ASK_DOB", content: "What is your date of birth?" };
    expect(filterDuplicate(lastMsg, nextDobMsg, {})).toBe(false);

    // Non-interactive identical statement is properly suppressed
    const plainMsg = { action: "NORMAL_CHAT", content: "Hello" };
    expect(filterDuplicate(plainMsg, plainMsg, {})).toBe(true);
  });
});
