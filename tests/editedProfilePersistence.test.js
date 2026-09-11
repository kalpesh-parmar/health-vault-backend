const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

describe("Edited Patient Profile Persistence Unit Tests", () => {
  test("Mobile + Upload: User edits extracted name 'Shraddha Chauhan' to 'Aastha Chauhan' and confirms", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "mobile",
      hasSocialData: false,
      currentStep: "RESOLVE_PROFILE_SOURCE",
      documentUploaded: true,
      documentConfirmed: true,
      documentData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1995-05-10",
        gender: "female",
      },
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1995-05-10",
        gender: "female",
      },
      profileConfirmed: false,
    };

    const payload = JSON.stringify({
      confirmed: true,
      source: "DOCUMENT",
      edited: {
        firstName: "Aastha",
        lastName: "Chauhan",
      },
    });

    const res = await onboardingService.chat(payload, [], initialState, null);

    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.existingUserData.firstName).toBe("Aastha");
    expect(res.state.existingUserData.lastName).toBe("Chauhan");
  });

  test("Social + Upload: Conflict resolution applies user edited details when provided", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "google",
      hasSocialData: true,
      socialData: {
        firstName: "John",
        lastName: "Doe",
      },
      currentStep: "RESOLVE_PROFILE_SOURCE",
      documentUploaded: true,
      documentConfirmed: true,
      documentData: {
        firstName: "Johnny",
        lastName: "Doe",
      },
      existingUserData: {},
      profileConfirmed: false,
    };

    const payload = JSON.stringify({
      source: "DOCUMENT",
      edited: {
        firstName: "Jonathan",
        lastName: "Doe",
      },
    });

    const res = await onboardingService.chat(payload, [], initialState, null);

    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.existingUserData.firstName).toBe("Jonathan");
    expect(res.state.existingUserData.lastName).toBe("Doe");
  });

  test("Manual Flow: User manual edits in profile confirmation card save edited data", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      loginProvider: "mobile",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      existingUserData: {
        firstName: "OldName",
        lastName: "User",
      },
      profileConfirmed: false,
    };

    const payload = JSON.stringify({
      edited: {
        firstName: "NewName",
        lastName: "User",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
    });

    const res = await onboardingService.chat(payload, [], initialState, null);

    expect(res.state.profileConfirmed).toBe(true);
    expect(res.state.existingUserData.firstName).toBe("NewName");
    expect(res.state.existingUserData.dateOfBirth).toBe("1990-01-01");
  });

  test("Social + Upload: User clicks 'Use Document' button with displayLabel payload and document details persist across turns", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "google",
      hasSocialData: true,
      socialData: {
        firstName: "SocialFirstName",
        lastName: "SocialLastName",
        email: "social@example.com",
      },
      currentStep: "RESOLVE_PROFILE_SOURCE",
      documentUploaded: true,
      documentConfirmed: true,
      documentData: {
        firstName: "URMILA",
        lastName: "HIPARARA",
        dateOfBirth: "2026-09-09",
        gender: "female",
      },
      existingUserData: {},
      profileConfirmed: false,
    };

    // Turn 1: User clicks "Use Document" button sending { displayLabel: "Use Document" }
    const turn1Payload = JSON.stringify({ displayLabel: "Use Document" });
    const res1 = await onboardingService.chat(turn1Payload, [], initialState, null);

    expect(res1.state.profileConfirmed).toBe(true);
    expect(res1.state.selectedProfileSource).toBe("DOCUMENT");
    expect(res1.state.existingUserData.firstName).toBe("URMILA");
    expect(res1.state.existingUserData.lastName).toBe("HIPARARA");

    // Turn 2: Subsequent turn (e.g. answering blood group) with sourceChoice = null
    const res2 = await onboardingService.chat("A+", [], res1.state, null);
    expect(res2.state.existingUserData.firstName).toBe("URMILA");
    expect(res2.state.existingUserData.lastName).toBe("HIPARARA");
  });

  test("Skip Flow: Skipping onboarding flow completes cleanly without errors", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      currentStep: "ASK_UPLOAD_OR_SKIP",
    };

    const res = await onboardingService.chat("SKIP", [], initialState, null);

    expect(res.state.flowMode).toBe("MANUAL");
  });
});
