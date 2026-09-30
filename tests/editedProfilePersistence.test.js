const {
  onboardingService,
  updateStateFromMessage,
} = require("../src/services/ai/chat/onboarding.service");

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

  describe("Phase 12: Confirmation Card & Conflict Card Matrix Tests", () => {
    test("Manual Entry with matching profile returns RESOLVE_PROFILE_SOURCE with mode: 'CONFIRM'", async () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "google",
        hasSocialData: true,
        socialData: {
          firstName: "John",
          lastName: "Doe",
        },
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        profileConfirmed: false,
        currentStep: "RESOLVE_PROFILE_SOURCE",
      };

      const res = await onboardingService.chat("hello", [], state, null);
      expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(res.mode).toBe("CONFIRM");
      expect(res.fields.length).toBe(6);
      expect(res.fields.every((f) => f.isMismatch === false)).toBe(true);
    });

    test("Manual Entry with conflicting profile returns RESOLVE_PROFILE_SOURCE with mode: 'CONFLICT'", async () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "google",
        hasSocialData: true,
        socialData: {
          firstName: "John",
          lastName: "Doe",
        },
        existingUserData: {
          firstName: "Jonathan",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        profileConfirmed: false,
        currentStep: "RESOLVE_PROFILE_SOURCE",
      };

      const res = await onboardingService.chat("hello", [], state, null);
      expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(res.mode).toBe("CONFLICT");
      const fnField = res.fields.find((f) => f.key === "firstName");
      expect(fnField.isMismatch).toBe(true);
      expect(res.sourceComparison).toBe("MANUAL_VS_LOGIN");
    });

    test("Upload Document with matching profile returns RESOLVE_PROFILE_SOURCE with mode: 'CONFIRM'", async () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        loginProvider: "google",
        hasSocialData: true,
        documentUploaded: true,
        documentConfirmed: true,
        socialData: {
          firstName: "John",
          lastName: "Doe",
        },
        documentData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        profileConfirmed: false,
        currentStep: "RESOLVE_PROFILE_SOURCE",
      };

      const res = await onboardingService.chat("hello", [], state, null);
      expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(res.mode).toBe("CONFIRM");
      expect(res.fields.every((f) => f.isMismatch === false)).toBe(true);
    });

    test("Upload Document with conflicting profile returns RESOLVE_PROFILE_SOURCE with mode: 'CONFLICT'", async () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        loginProvider: "google",
        hasSocialData: true,
        documentUploaded: true,
        documentConfirmed: true,
        socialData: {
          firstName: "John",
          lastName: "Doe",
        },
        documentData: {
          firstName: "Johnny",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        existingUserData: {
          firstName: "Johnny",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        profileConfirmed: false,
        currentStep: "RESOLVE_PROFILE_SOURCE",
      };

      const res = await onboardingService.chat("hello", [], state, null);
      expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(res.mode).toBe("CONFLICT");
      const fnField = res.fields.find((f) => f.key === "firstName");
      expect(fnField.isMismatch).toBe(true);
      expect(res.sourceComparison).toBe("DOCUMENT_VS_LOGIN");
    });

    test("Dispatching { confirmed: true } sets profileConfirmed = true, updates patient DB, and advances to ASK_BLOOD_GROUP", async () => {
      const patientRepository = require("../src/repositories/patientRepository");
      const authProviderRepository = require("../src/repositories/authProviderRepository");
      const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
      const { chatService } = require("../src/services/ai/chat/chat.service");

      const findSpy = jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "user-persist-123",
        firstName: "John",
        lastName: "Doe",
        gender: "male",
      });
      const authSpy = jest
        .spyOn(authProviderRepository, "findByUserId")
        .mockResolvedValue([{ provider: "google" }]);
      const updateSpy = jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      const uOnbFindSpy = jest
        .spyOn(userOnboardingRepository, "findByUserId")
        .mockResolvedValue({ data: {} });
      const uOnbUpdateSpy = jest
        .spyOn(userOnboardingRepository, "updateByUserId")
        .mockResolvedValue({});
      const chatCreateSpy = jest
        .spyOn(chatService, "createOnboardingSession")
        .mockResolvedValue({ id: "session-1" });
      const chatGetSpy = jest
        .spyOn(chatService, "getOrCreateCanonicalSession")
        .mockResolvedValue({ id: "session-1" });
      const chatAppendSpy = jest
        .spyOn(chatService, "appendChatMessage")
        .mockResolvedValue({ createdAt: new Date() });

      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "google",
        hasSocialData: true,
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        profileConfirmed: false,
        currentStep: "RESOLVE_PROFILE_SOURCE",
      };

      const payload = JSON.stringify({ confirmed: true });
      const res = await onboardingService.chat(payload, [], state, "user-persist-123");

      expect(res.state.profileConfirmed).toBe(true);
      expect(res.action).toBe("ASK_BLOOD_GROUP");
      expect(updateSpy).toHaveBeenCalledWith(
        "user-persist-123",
        expect.objectContaining({
          firstName: "John",
          lastName: "Doe",
          gender: "male",
        }),
      );
      findSpy.mockRestore();
      authSpy.mockRestore();
      updateSpy.mockRestore();
      uOnbFindSpy.mockRestore();
      uOnbUpdateSpy.mockRestore();
      chatCreateSpy.mockRestore();
      chatGetSpy.mockRestore();
      chatAppendSpy.mockRestore();
    });
  });

  describe("Phase 13: Confirmation Card Edit Details Pre-population & Verification Semantics", () => {
    test("Manual entry questions leave loginData with verified: false and provenance: 'manual'", async () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "mobile",
        currentStep: "ASK_FIRST_NAME",
        existingUserData: {},
        loginData: {},
      };

      state.currentStep = "ASK_FIRST_NAME";
      await updateStateFromMessage(state, "Jane", null);
      expect(state.existingUserData.firstName).toBe("Jane");
      expect(state.loginData.firstName).toEqual({
        value: "Jane",
        verified: false,
        provenance: "manual",
      });

      state.currentStep = "ASK_LAST_NAME";
      await updateStateFromMessage(state, "Doe", null);
      expect(state.existingUserData.lastName).toBe("Doe");
      expect(state.loginData.lastName).toEqual({
        value: "Doe",
        verified: false,
        provenance: "manual",
      });

      state.currentStep = "ASK_DOB";
      await updateStateFromMessage(state, "1994-04-20", null);
      expect(state.existingUserData.dateOfBirth).toBe("1994-04-20");
      expect(state.loginData.dateOfBirth).toEqual({
        value: "1994-04-20",
        verified: false,
        provenance: "manual",
      });

      state.currentStep = "ASK_GENDER";
      await updateStateFromMessage(state, "female", null);
      expect(state.existingUserData.gender).toBe("female");
      expect(state.loginData.gender).toEqual({
        value: "female",
        verified: false,
        provenance: "manual",
      });
    });

    test("RESOLVE_PROFILE_SOURCE payload returns editable: true and verified: false for all demographic fields", async () => {
      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "email",
        hasSocialData: false,
        existingUserData: {
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1994-04-20",
          gender: "female",
          email: "jane.doe@example.com",
        },
        loginData: {
          firstName: { value: "Jane", verified: false, provenance: "manual" },
          lastName: { value: "Doe", verified: false, provenance: "manual" },
          dateOfBirth: { value: "1994-04-20", verified: false, provenance: "manual" },
          gender: { value: "female", verified: false, provenance: "manual" },
          email: { value: "jane.doe@example.com", verified: true, provenance: "auth" },
        },
        profileConfirmed: false,
        currentStep: "RESOLVE_PROFILE_SOURCE",
      };

      const res = await onboardingService.chat("hello", [], state, null);
      expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(res.mode).toBe("CONFIRM");

      const fn = res.fields.find((f) => f.key === "firstName");
      const ln = res.fields.find((f) => f.key === "lastName");
      const dob = res.fields.find((f) => f.key === "dateOfBirth");
      const gen = res.fields.find((f) => f.key === "gender");
      const email = res.fields.find((f) => f.key === "email");

      expect(fn).toMatchObject({ verified: false, editable: true });
      expect(ln).toMatchObject({ verified: false, editable: true });
      expect(dob).toMatchObject({ verified: false, editable: true });
      expect(gen).toMatchObject({ verified: false, editable: true });
      expect(email).toMatchObject({ verified: true, editable: false });
    });

    test("Confirmation Card edit submission { confirmed: true, edited: { ... } } persists changes and advances", async () => {
      const patientRepository = require("../src/repositories/patientRepository");
      const authProviderRepository = require("../src/repositories/authProviderRepository");
      const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
      const { chatService } = require("../src/services/ai/chat/chat.service");

      const findSpy = jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: "user-edit-456",
        firstName: "Jane",
        lastName: "Doe",
        gender: "female",
      });
      const authSpy = jest
        .spyOn(authProviderRepository, "findByUserId")
        .mockResolvedValue([{ provider: "mobile" }]);
      const updateSpy = jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
      const uOnbFindSpy = jest
        .spyOn(userOnboardingRepository, "findByUserId")
        .mockResolvedValue({ data: {} });
      const uOnbUpdateSpy = jest
        .spyOn(userOnboardingRepository, "updateByUserId")
        .mockResolvedValue({});
      const chatCreateSpy = jest
        .spyOn(chatService, "createOnboardingSession")
        .mockResolvedValue({ id: "session-2" });
      const chatGetSpy = jest
        .spyOn(chatService, "getOrCreateCanonicalSession")
        .mockResolvedValue({ id: "session-2" });
      const chatAppendSpy = jest
        .spyOn(chatService, "appendChatMessage")
        .mockResolvedValue({ createdAt: new Date() });

      const state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "mobile",
        hasSocialData: false,
        existingUserData: {
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1994-04-20",
          gender: "female",
        },
        profileConfirmed: false,
        currentStep: "RESOLVE_PROFILE_SOURCE",
      };

      const payload = JSON.stringify({
        confirmed: true,
        edited: {
          firstName: "Janet",
          lastName: "Doe-Smith",
          dateOfBirth: "1993-05-15",
          gender: "female",
        },
      });

      const res = await onboardingService.chat(payload, [], state, "user-edit-456");

      expect(res.state.profileConfirmed).toBe(true);
      expect(res.action).toBe("ASK_BLOOD_GROUP");
      expect(res.state.existingUserData.firstName).toBe("Janet");
      expect(res.state.existingUserData.lastName).toBe("Doe-Smith");
      expect(updateSpy).toHaveBeenCalledWith(
        "user-edit-456",
        expect.objectContaining({
          firstName: "Janet",
          lastName: "Doe-Smith",
          gender: "female",
        }),
      );

      findSpy.mockRestore();
      authSpy.mockRestore();
      updateSpy.mockRestore();
      uOnbFindSpy.mockRestore();
      uOnbUpdateSpy.mockRestore();
      chatCreateSpy.mockRestore();
      chatGetSpy.mockRestore();
      chatAppendSpy.mockRestore();
    });
  });
});
