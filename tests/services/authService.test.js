const patientService = require("../../src/services/patientService");
const patientRepository = require("../../src/repositories/patientRepository");
const sessionRepository = require("../../src/repositories/sessionRepository");
const loginAttemptRepository = require("../../src/repositories/loginAttemptRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../../src/repositories/authProviderRepository");
const {
  verifyFirebaseToken,
  findOrCreateFirebaseUser,
  createCustomFirebaseToken,
} = require("../../src/configs/firebase");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/sessionRepository");
jest.mock("../../src/repositories/loginAttemptRepository");
jest.mock("../../src/repositories/userOnboardingRepository");
jest.mock("../../src/repositories/authProviderRepository");
jest.mock("../../src/configs/firebase");
jest.mock("../../src/configs/env", () => {
  const actual = jest.requireActual("../../src/configs/env");
  return {
    env: {
      ...actual.env,
      enableDummyAuth: true,
      microsoftClientId: "test-client-id",
    },
  };
});

describe("PatientService - Social/Mobile Login", () => {
  beforeEach(() => {
    // Reset all mock behaviors to prevent state leakage
    jest.resetAllMocks();

    // Default mocks for helper repositories to avoid hitting the actual database
    loginAttemptRepository.findAttempt.mockResolvedValue(null);
    loginAttemptRepository.resetAttempts.mockResolvedValue({});
    authProviderRepository.findByProvider.mockResolvedValue(null);
    authProviderRepository.create.mockResolvedValue({});
    userOnboardingRepository.findByUserId.mockResolvedValue(null);
  });

  it("should successfully login an existing mobile patient", async () => {
    const mockToken = "mock-firebase-token";
    const mockDecodedToken = {
      phone_number: "+919999999999",
      uid: "mock-firebase-uid-123",
    };

    verifyFirebaseToken.mockResolvedValue(mockDecodedToken);

    const mockPatient = {
      id: "mock-uuid-1",
      mobile: "9999999999",
      countryCode: "+91",
      firebaseUid: "mock-firebase-uid-123",
      fullName: "Existing User",
      status: "ACTIVE",
    };

    patientRepository.findByMobile.mockResolvedValue(mockPatient);
    patientRepository.updateById.mockResolvedValue(mockPatient);
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.socialLogin({
      loginType: "mobile",
      provider: "mobile",
      firebaseIdToken: mockToken,
      deviceToken: "mock-device-token",
    });

    expect(verifyFirebaseToken).toHaveBeenCalledWith(mockToken);
    expect(patientRepository.findByMobile).toHaveBeenCalledWith("9999999999");
    expect(patientRepository.updateById).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.user.mobile).toBe("9999999999");
    expect(result.token).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it("should automatically register a new mobile patient if they do not exist", async () => {
    const mockToken = "mock-firebase-token-new";
    const mockDecodedToken = {
      phone_number: "+918888888888",
      uid: "mock-firebase-uid-456",
    };

    verifyFirebaseToken.mockResolvedValue(mockDecodedToken);
    patientRepository.findByMobile.mockResolvedValue(null);

    const mockCreatedPatient = {
      id: "mock-uuid-2",
      mobile: "8888888888",
      countryCode: "+91",
      firebaseUid: "mock-firebase-uid-456",
      fullName: "User 8888888888",
      status: "ACTIVE",
    };

    patientRepository.create.mockResolvedValue(mockCreatedPatient);
    patientRepository.updateById.mockResolvedValue(mockCreatedPatient);
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.socialLogin({
      loginType: "mobile",
      provider: "mobile",
      firebaseIdToken: mockToken,
    });

    expect(verifyFirebaseToken).toHaveBeenCalledWith(mockToken);
    expect(patientRepository.findByMobile).toHaveBeenCalledWith("8888888888");
    expect(patientRepository.create).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.user.mobile).toBe("8888888888");
  });

  it("should bypass Firebase verification when enableDummyAuth is true and token matches dummy token", async () => {
    const mockPatient = {
      id: "mock-uuid-dummy",
      mobile: "1111111111",
      countryCode: "+91",
      firebaseUid: "mock-uid-mobile-dummy-token-msAipc6g4vNEQl24OePv56pe6Qy2",
      fullName: "Dummy User",
      status: "ACTIVE",
    };

    patientRepository.findByMobile.mockResolvedValue(mockPatient);
    patientRepository.updateById.mockResolvedValue(mockPatient);
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.socialLogin({
      loginType: "mobile",
      provider: "mobile",
      firebaseIdToken: "dummy-token-msAipc6g4vNEQl24OePv56pe6Qy2",
    });

    expect(verifyFirebaseToken).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.user.mobile).toBe("1111111111");
  });

  it("should successfully login with Microsoft using backend Custom Token flow", async () => {
    // Prefix dummy- to match dummy authorization handling
    const mockMicrosoftToken = "dummy-microsoft-123";

    const mockPatient = {
      id: "mock-uuid-microsoft",
      email: "microsoft-mockuser@example.com",
      firebaseUid: "microsoft_microsoft-123",
      fullName: "Mock MicrosoftUser",
      status: "ACTIVE",
    };

    findOrCreateFirebaseUser.mockResolvedValue({ uid: "microsoft_microsoft-123" });
    createCustomFirebaseToken.mockResolvedValue("mock-firebase-custom-token");

    patientRepository.findByEmail.mockResolvedValue(mockPatient);
    patientRepository.updateById.mockResolvedValue(mockPatient);
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "microsoft",
      providerToken: mockMicrosoftToken,
      deviceToken: "mock-device-token",
    });

    expect(findOrCreateFirebaseUser).toHaveBeenCalledWith(
      "microsoft-mockuser@example.com",
      "Mock MicrosoftUser",
      "microsoft-123",
    );
    expect(createCustomFirebaseToken).toHaveBeenCalledWith("microsoft_microsoft-123");
    expect(result.success).toBe(true);
    expect(result.firebaseCustomToken).toBe("mock-firebase-custom-token");
    expect(result.token).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it("should prefer profile name (firstName + lastName) over social fullName in login response", async () => {
    const mockToken = "mock-firebase-token-pref";
    const mockDecodedToken = {
      email: "preferred@example.com",
      uid: "mock-firebase-uid-pref",
    };

    verifyFirebaseToken.mockResolvedValue(mockDecodedToken);

    const mockPatient = {
      id: "mock-uuid-pref",
      email: "preferred@example.com",
      firebaseUid: "mock-firebase-uid-pref",
      firstName: "ProfileFirst",
      lastName: "ProfileLast",
      fullName: "SocialFullName",
      status: "ACTIVE",
    };

    patientRepository.findByEmail.mockResolvedValue(mockPatient);
    patientRepository.updateById.mockResolvedValue(mockPatient);
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "google",
      firebaseIdToken: mockToken,
    });

    expect(result.success).toBe(true);
    expect(result.user.name).toBe("ProfileFirst ProfileLast");
  });

  it("should fall back to social fullName if firstName/lastName are empty", async () => {
    const mockToken = "mock-firebase-token-fallback";
    const mockDecodedToken = {
      email: "fallback@example.com",
      uid: "mock-firebase-uid-fallback",
    };

    verifyFirebaseToken.mockResolvedValue(mockDecodedToken);

    const mockPatient = {
      id: "mock-uuid-fallback",
      email: "fallback@example.com",
      firebaseUid: "mock-firebase-uid-fallback",
      fullName: "SocialFullName",
      status: "ACTIVE",
    };

    patientRepository.findByEmail.mockResolvedValue(mockPatient);
    patientRepository.updateById.mockResolvedValue(mockPatient);
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "google",
      firebaseIdToken: mockToken,
    });

    expect(result.success).toBe(true);
    expect(result.user.name).toBe("SocialFullName");
  });
});
