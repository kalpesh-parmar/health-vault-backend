const patientService = require("../../src/services/patient.service");
const authProviderRepository = require("../../src/repositories/authProviderRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const sessionRepository = require("../../src/repositories/sessionRepository");
const loginAttemptRepository = require("../../src/repositories/loginAttemptRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const appleUtils = require("../../src/utils/appleUtils");
const firebaseConfig = require("../../src/configs/firebase");
const { USER_STATUS } = require("../../src/enums/userStatus.enum");

jest.mock("../../src/repositories/authProviderRepository");
jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/sessionRepository");
jest.mock("../../src/repositories/loginAttemptRepository");
jest.mock("../../src/repositories/userOnboardingRepository");
jest.mock("../../src/utils/appleUtils");
jest.mock("../../src/configs/firebase");

describe("Apple Social Login in patient.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    loginAttemptRepository.findAttempt.mockResolvedValue(null);
    loginAttemptRepository.resetAttempts.mockResolvedValue();
    sessionRepository.create.mockResolvedValue();
    userOnboardingRepository.findByUserId.mockResolvedValue(null);
    firebaseConfig.findOrCreateFirebaseUser.mockResolvedValue({ uid: "apple_001234.sub" });
    firebaseConfig.createCustomFirebaseToken.mockResolvedValue("mock-firebase-custom-token");
  });

  test("New Apple user: creates new patient and auth_provider, returns custom token and session", async () => {
    appleUtils.verifyAppleToken.mockResolvedValueOnce({
      sub: "apple_sub_12345",
      email: "user@privaterelay.appleid.com",
      email_verified: true,
      is_private_email: true,
    });

    authProviderRepository.findByProvider.mockResolvedValue(null);
    patientRepository.findByPatientCode.mockResolvedValue(null);

    const createdPatient = {
      id: "patient-uuid-1",
      patientCode: "123456",
      email: "user@privaterelay.appleid.com",
      firstName: "John",
      lastName: "Appleseed",
      fullName: "John Appleseed",
      status: USER_STATUS.ACTIVE,
      isEmailVerified: true,
      onboardingCompleted: false,
    };
    patientRepository.create.mockResolvedValue(createdPatient);
    patientRepository.updateById.mockResolvedValue(createdPatient);
    authProviderRepository.create.mockResolvedValue({ id: "ap-1" });

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "apple",
      providerToken: "valid-apple-jwt",
      firstName: "John",
      lastName: "Appleseed",
      email: "user@privaterelay.appleid.com",
    });

    expect(result.success).toBe(true);
    expect(result.isNewUser).toBe(true);
    expect(result.firebaseCustomToken).toBe("mock-firebase-custom-token");
    expect(authProviderRepository.findByProvider).toHaveBeenCalledWith("apple", "apple_sub_12345");
    expect(authProviderRepository.create).toHaveBeenCalledWith({
      userId: "patient-uuid-1",
      provider: "apple",
      providerUserId: "apple_sub_12345",
      email: "user@privaterelay.appleid.com",
    });
    expect(firebaseConfig.findOrCreateFirebaseUser).toHaveBeenCalledWith(
      "user@privaterelay.appleid.com",
      "John Appleseed",
      "apple_sub_12345",
      "apple",
    );
  });

  test("Existing Apple user: loads by sub, returns session, does not overwrite existing name with null", async () => {
    // Subsequent login: Apple only returns sub (no email/name in token or payload)
    appleUtils.verifyAppleToken.mockResolvedValueOnce({
      sub: "apple_sub_12345",
      email: null,
      email_verified: false,
      is_private_email: false,
    });

    const existingPatient = {
      id: "patient-uuid-1",
      patientCode: "123456",
      email: "user@privaterelay.appleid.com",
      firstName: "John",
      lastName: "Appleseed",
      fullName: "John Appleseed",
      status: USER_STATUS.ACTIVE,
      isEmailVerified: true,
      onboardingCompleted: false,
    };

    authProviderRepository.findByProvider.mockResolvedValueOnce({
      id: "ap-1",
      userId: "patient-uuid-1",
      provider: "apple",
      providerUserId: "apple_sub_12345",
    });
    patientRepository.findById.mockResolvedValueOnce(existingPatient);
    patientRepository.updateById.mockResolvedValue(existingPatient);

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "apple",
      providerToken: "valid-apple-jwt",
      // No email or name passed on subsequent login
    });

    expect(result.success).toBe(true);
    expect(result.isNewUser).toBe(false);
    expect(result.user.name).toBe("John Appleseed");
    expect(result.user.email).toBe("user@privaterelay.appleid.com");

    // Verify updateById does not overwrite existing names/email with null
    const updateCall = patientRepository.updateById.mock.calls[0][1];
    expect(updateCall.email).toBeUndefined();
    expect(updateCall.firstName).toBeUndefined();
    expect(updateCall.lastName).toBeUndefined();
  });

  test("Security check: Apple user with existing email in system does NOT auto-link to that account", async () => {
    appleUtils.verifyAppleToken.mockResolvedValueOnce({
      sub: "new_apple_sub_999",
      email: "existing_user@example.com",
      email_verified: true,
      is_private_email: false,
    });

    authProviderRepository.findByProvider.mockResolvedValue(null);
    patientRepository.findByPatientCode.mockResolvedValue(null);

    const createdPatient = {
      id: "new-patient-uuid-2",
      patientCode: "654321",
      email: "existing_user@example.com",
      status: USER_STATUS.ACTIVE,
      isEmailVerified: true,
      onboardingCompleted: false,
    };
    patientRepository.create.mockResolvedValue(createdPatient);
    patientRepository.updateById.mockResolvedValue(createdPatient);
    authProviderRepository.create.mockResolvedValue({ id: "ap-2" });

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "apple",
      providerToken: "valid-apple-jwt",
      email: "existing_user@example.com",
    });

    expect(result.isNewUser).toBe(true);
    // patientRepository.findByEmail must NOT be called for Apple
    expect(patientRepository.findByEmail).not.toHaveBeenCalled();
    expect(patientRepository.create).toHaveBeenCalled();
  });

  test("Dummy Auth: dummy-apple-token works when enableDummyAuth is active", async () => {
    authProviderRepository.findByProvider.mockResolvedValue(null);
    patientRepository.findByPatientCode.mockResolvedValue(null);

    const createdPatient = {
      id: "dummy-patient-id",
      patientCode: "777777",
      email: "dummy@apple.com",
      status: USER_STATUS.ACTIVE,
      isEmailVerified: true,
      onboardingCompleted: false,
    };
    patientRepository.create.mockResolvedValue(createdPatient);
    patientRepository.updateById.mockResolvedValue(createdPatient);
    authProviderRepository.create.mockResolvedValue({ id: "ap-3" });

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "apple",
      providerToken: "dummy-test-sub-123",
      email: "dummy@apple.com",
      firstName: "Dummy",
      lastName: "AppleUser",
    });

    expect(result.success).toBe(true);
    expect(result.isNewUser).toBe(true);
    expect(appleUtils.verifyAppleToken).not.toHaveBeenCalled(); // bypassed
    expect(firebaseConfig.findOrCreateFirebaseUser).toHaveBeenCalledWith(
      "dummy@apple.com",
      "Dummy AppleUser",
      "test-sub-123",
      "apple",
    );
  });

  test("Backward Compatibility: Microsoft login continues to generate microsoft_ prefix", async () => {
    authProviderRepository.findByProvider.mockResolvedValue(null);
    patientRepository.findByPatientCode.mockResolvedValue(null);

    const createdPatient = {
      id: "ms-patient-id",
      patientCode: "888888",
      email: "ms@example.com",
      status: USER_STATUS.ACTIVE,
      isEmailVerified: true,
      onboardingCompleted: false,
    };
    patientRepository.create.mockResolvedValue(createdPatient);
    patientRepository.updateById.mockResolvedValue(createdPatient);
    authProviderRepository.create.mockResolvedValue({ id: "ap-ms" });

    const result = await patientService.socialLogin({
      loginType: "social",
      provider: "microsoft",
      providerToken: "dummy-ms-oid-123",
      email: "ms@example.com",
    });

    expect(result.success).toBe(true);
    expect(result.isNewUser).toBe(true);
    expect(firebaseConfig.findOrCreateFirebaseUser).toHaveBeenCalledWith(
      null,
      null,
      "ms-oid-123",
      "microsoft",
    );
    expect(firebaseConfig.createCustomFirebaseToken).toHaveBeenCalledWith("microsoft_ms-oid-123");
  });
});
