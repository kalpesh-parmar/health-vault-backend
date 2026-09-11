const ocrService = require("../src/services/ocr.service");
// const { onboardingService } = require("../src/services/ai/chat/onboarding.service");
const patientRepository = require("../src/repositories/patientRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const documentRepository = require("../src/repositories/documentRepository");
// const medicationService = require("../src/services/medication.service");
const { chatService } = require("../src/services/ai/chat/chat.service");

jest.setTimeout(30000);

describe("Social + Document Upload Onboarding 3-Choice Matrix Tests", () => {
  let dbStates = {};

  beforeEach(() => {
    jest.restoreAllMocks();
    dbStates = {};

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-matrix-1",
      firstName: "Shraddha",
      lastName: "Chauhan",
      email: "shraddhac734@gmail.com",
      gender: "female",
      dateOfBirth: new Date("2006-02-24"),
      onboardingCompleted: false,
    });
    jest.spyOn(patientRepository, "updateById").mockImplementation(async (id, data) => {
      return { id, ...data };
    });
    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([{ provider: "google" }]);
    jest.spyOn(userOnboardingRepository, "findByUserId").mockImplementation(async (userId) => {
      return { data: dbStates[userId] || {} };
    });
    jest
      .spyOn(userOnboardingRepository, "updateByUserId")
      .mockImplementation(async (userId, payload) => {
        dbStates[userId] = payload.data;
        return {};
      });
    jest.spyOn(documentRepository, "findById").mockResolvedValue({
      id: "doc-matrix-1",
      structuredExtractedData: {
        patientInfo: {
          firstName: "Aastha",
          lastName: "Chauhan",
          gender: "female",
          dateOfBirth: "2006-02-24",
        },
      },
    });
    jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({ id: "session-1" });
    jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({ createdAt: new Date() });
  });

  test("1] USE SOCIAL DATA: patient data persists as Social info across skipping and DASHBOARD selection", async () => {
    let initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "google",
      hasSocialData: true,
      loginData: {
        firstName: { value: "Shraddha", verified: true },
        lastName: { value: "Chauhan", verified: true },
        email: { value: "shraddhac734@gmail.com", verified: true },
      },
      documentId: "doc-matrix-1",
      documentUploaded: true,
      documentExtracted: true,
      documentConfirmed: true,
      documentOwnershipConfirmed: true,
      documentData: {
        firstName: "Aastha",
        lastName: "Chauhan",
        dateOfBirth: "2006-02-24",
        gender: "female",
      },
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
      currentStep: "RESOLVE_PROFILE_SOURCE",
    };
    dbStates["user-matrix-1"] = initialState;

    // User chooses USE SOCIAL DATA
    let res = await ocrService.onboardingChat("user-matrix-1", {
      message: JSON.stringify({ source: "SOCIAL" }),
      state: initialState,
    });

    expect(res.onboardingState.existingUserData.firstName).toBe("Shraddha");
    expect(res.onboardingState.selectedProfileSource).toBe("SOCIAL");
    expect(res.onboardingState.profileConfirmed).toBe(true);

    // Next step: User clicks DASHBOARD on MEDICINE_OPTIONS with stale client state
    let staleClientState = {
      ...res.onboardingState,
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
    };

    let dashboardRes = await ocrService.onboardingChat("user-matrix-1", {
      message: "DASHBOARD",
      state: staleClientState,
    });

    expect(dashboardRes.onboardingState.existingUserData.firstName).toBe("Shraddha");
    expect(dashboardRes.onboardingState.selectedProfileSource).toBe("SOCIAL");
  }, 30000);

  test("2] USE DOCUMENT DATA: patient data persists as Document info across skipping and DASHBOARD selection", async () => {
    let initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "google",
      hasSocialData: true,
      loginData: {
        firstName: { value: "Shraddha", verified: true },
        lastName: { value: "Chauhan", verified: true },
        email: { value: "shraddhac734@gmail.com", verified: true },
      },
      documentId: "doc-matrix-1",
      documentUploaded: true,
      documentExtracted: true,
      documentConfirmed: true,
      documentOwnershipConfirmed: true,
      documentData: {
        firstName: "Aastha",
        lastName: "Chauhan",
        dateOfBirth: "2006-02-24",
        gender: "female",
      },
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
      currentStep: "RESOLVE_PROFILE_SOURCE",
    };
    dbStates["user-matrix-1"] = initialState;

    // User chooses USE DOCUMENT DATA
    let res = await ocrService.onboardingChat("user-matrix-1", {
      message: JSON.stringify({ source: "DOCUMENT" }),
      state: initialState,
    });

    expect(res.onboardingState.existingUserData.firstName).toBe("Aastha");
    expect(res.onboardingState.selectedProfileSource).toBe("DOCUMENT");
    expect(res.onboardingState.profileConfirmed).toBe(true);

    // Simulate stale client sending old social details ("Shraddha") on DASHBOARD selection
    let staleClientState = {
      ...res.onboardingState,
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
    };

    let dashboardRes = await ocrService.onboardingChat("user-matrix-1", {
      message: "DASHBOARD",
      state: staleClientState,
    });

    // Verify DB/Response data is NOT overwritten back to "Shraddha"
    expect(dashboardRes.onboardingState.existingUserData.firstName).toBe("Aastha");
    expect(dashboardRes.onboardingState.selectedProfileSource).toBe("DOCUMENT");
  });

  test("3] EDIT DETAILS MANUALLY: patient data persists as Manual Edited info across skipping and DASHBOARD selection", async () => {
    let initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "google",
      hasSocialData: true,
      loginData: {
        firstName: { value: "Shraddha", verified: true },
        lastName: { value: "Chauhan", verified: true },
        email: { value: "shraddhac734@gmail.com", verified: true },
      },
      documentId: "doc-matrix-1",
      documentUploaded: true,
      documentExtracted: true,
      documentConfirmed: true,
      documentOwnershipConfirmed: true,
      documentData: {
        firstName: "Aastha",
        lastName: "Chauhan",
        dateOfBirth: "2006-02-24",
        gender: "female",
      },
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
      currentStep: "RESOLVE_PROFILE_SOURCE",
    };
    dbStates["user-matrix-1"] = initialState;

    // User edits details manually to "Dharmik Bapodara"
    let res = await ocrService.onboardingChat("user-matrix-1", {
      message: JSON.stringify({
        edited: {
          firstName: "Dharmik",
          lastName: "Bapodara",
          dateOfBirth: "2006-02-24",
          gender: "male",
        },
      }),
      state: initialState,
    });

    expect(res.onboardingState.existingUserData.firstName).toBe("Dharmik");
    expect(res.onboardingState.existingUserData.lastName).toBe("Bapodara");
    expect(res.onboardingState.selectedProfileSource).toBe("MANUAL");
    expect(res.onboardingState.profileConfirmed).toBe(true);

    // Simulate stale client sending old social details ("Shraddha") on DASHBOARD selection
    let staleClientState = {
      ...res.onboardingState,
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
      },
    };

    let dashboardRes = await ocrService.onboardingChat("user-matrix-1", {
      message: "DASHBOARD",
      state: staleClientState,
    });

    // Verify DB/Response data is NOT overwritten back to "Shraddha"
    expect(dashboardRes.onboardingState.existingUserData.firstName).toBe("Dharmik");
    expect(dashboardRes.onboardingState.existingUserData.lastName).toBe("Bapodara");
    expect(dashboardRes.onboardingState.selectedProfileSource).toBe("MANUAL");
  });
});
