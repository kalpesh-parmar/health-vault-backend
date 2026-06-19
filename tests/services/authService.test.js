/* global jest, describe, beforeEach, it, expect */
const patientService = require("../../src/services/patientService");
const patientRepository = require("../../src/repositories/patientRepository");
const sessionRepository = require("../../src/repositories/sessionRepository");
const { verifyFirebaseToken } = require("../../src/configs/firebase");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/sessionRepository");
jest.mock("../../src/configs/firebase");
jest.mock("../../src/configs/env", () => {
  const actual = jest.requireActual("../../src/configs/env");
  return {
    env: {
      ...actual.env,
      enableDummyAuth: true,
    },
  };
});

describe("PatientService - Firebase Login", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should successfully login an existing patient", async () => {
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

    const result = await patientService.firebaseLogin({
      firebaseToken: mockToken,
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

  it("should automatically register a new patient if they do not exist", async () => {
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
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.firebaseLogin({
      firebaseToken: mockToken,
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
      firebaseUid: "msAipc6g4vNEQl24OePv56pe6Qy2",
      fullName: "Dummy User",
      status: "ACTIVE",
    };

    patientRepository.findByMobile.mockResolvedValue(mockPatient);
    patientRepository.updateById.mockResolvedValue(mockPatient);
    sessionRepository.create.mockResolvedValue({});

    const result = await patientService.firebaseLogin({
      firebaseToken: "dummy-token-msAipc6g4vNEQl24OePv56pe6Qy2",
    });

    expect(verifyFirebaseToken).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.user.mobile).toBe("1111111111");
  });
});
