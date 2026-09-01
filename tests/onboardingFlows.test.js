const onboardingServiceModule = require("../src/services/ai/chat/onboarding.service");
const { onboardingService, canSkipOnboarding } = onboardingServiceModule;
const patientRepository = require("../src/repositories/patientRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const documentRepository = require("../src/repositories/documentRepository");
const medicationService = require("../src/services/medication.service");
const { chatService } = require("../src/services/ai/chat/chat.service");
const { ollamaClient } = require("../src/clients/ollamaClient");
const { db } = require("../src/configs/db");

describe("Comprehensive Onboarding & Post-Onboarding Flows Test Suite", () => {
  let dbStates = {};

  beforeEach(() => {
    jest.restoreAllMocks();
    dbStates = {};
    jest.spyOn(ollamaClient, "chat").mockResolvedValue({
      message: { content: JSON.stringify({ value: "ExtractedValue" }) },
    });
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-101",
      firstName: null,
      lastName: null,
      dateOfBirth: null,
      gender: null,
      onboardingCompleted: false,
    });
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([{ provider: "google" }]);
    jest.spyOn(documentRepository, "findById").mockResolvedValue({
      id: "doc-123",
      structuredExtractedData: {
        patientInfo: {
          firstName: "John",
          lastName: "Doe",
          gender: "male",
          dateOfBirth: "1990-01-01",
        },
      },
    });
    jest.spyOn(db, "select").mockReturnValue({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: "doc-123",
              structuredExtractedData: {
                patientInfo: {
                  firstName: "John",
                  lastName: "Doe",
                  gender: "male",
                  dateOfBirth: "1990-01-01",
                },
                medications: [
                  { name: "Metformin 500mg", dose: "1 tablet", frequency: "ONCE_DAILY" },
                ],
              },
            },
          ]),
      }),
    });
    jest
      .spyOn(medicationService, "checkDuplicateMedicationsBatch")
      .mockImplementation((userId, meds) => Promise.resolve(meds));
    jest.spyOn(chatService, "attachDocumentToSession").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "findByUserId").mockImplementation(async (userId) => {
      return { data: dbStates[userId] || {} };
    });
    jest
      .spyOn(userOnboardingRepository, "updateByUserId")
      .mockImplementation(async (userId, payload) => {
        dbStates[userId] = payload.data;
        return {};
      });
    jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({ id: "session-1" });
    jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({ createdAt: new Date() });
  });

  // =========================================================================
  // FLOW 1: UPLOAD + SOCIAL
  // =========================================================================
  describe("Flow 1: UPLOAD + SOCIAL", () => {
    test("[IF USER DOES NOT SKIP] Should complete all onboarding steps and return 3 buttons on MEDICINE_OPTIONS", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        loginProvider: "google",
        hasSocialData: true,
        loginData: {
          firstName: { value: "John", verified: true },
          lastName: { value: "Doe", verified: true },
          email: { value: "john.doe@gmail.com", verified: true },
          gender: { value: "male", verified: false },
          dateOfBirth: { value: "1990-01-01", verified: false },
        },
        socialData: {
          firstName: "John",
          lastName: "Doe",
          email: "john.doe@gmail.com",
          gender: "male",
          dateOfBirth: "1990-01-01",
        },
        documentId: "doc-123",
        documentUploaded: true,
        documentExtracted: true,
        documentConfirmed: true,
        documentOwnershipConfirmed: true,
        documentData: {
          firstName: "John",
          lastName: "Doe",
          gender: "male",
          dateOfBirth: "1990-01-01",
        },
        foundMedicines: [{ name: "Metformin 500mg", dose: "1 tablet", frequency: "ONCE_DAILY" }],
      };
      dbStates["user-101"] = state;

      // Step 1: Resolve Profile Source
      state.currentStep = "RESOLVE_PROFILE_SOURCE";
      let res = await onboardingService.chat("LOGIN", [], state, "user-101");
      state = res.state;
      expect(state.profileConfirmed).toBe(true);

      // Step 2: Ask Blood Group
      expect(res.action).toBe("ASK_BLOOD_GROUP");
      res = await onboardingService.chat("O+", [], state, "user-101");
      state = res.state;

      // Step 3: Ask Allergies
      expect(res.action).toBe("ASK_ALLERGIES");
      res = await onboardingService.chat("None", [], state, "user-101");
      state = res.state;

      // Step 4: Review Extracted Medicines
      expect(res.action).toBe("REVIEW_MEDICINES_LIST");
      expect(res.medicines.length).toBeGreaterThan(0);

      // Step 5: Confirm Medicines
      jest.spyOn(medicationService, "bulkCreate").mockResolvedValue([{ id: "med-db-1" }]);
      res = await onboardingService.chat(
        JSON.stringify({ value: "CONFIRM" }),
        [],
        state,
        "user-101",
      );
      state = res.state;

      // Step 6: Verify MEDICINE_OPTIONS returns EXACTLY 3 buttons during onboarding
      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(3);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("DASHBOARD");
      expect(keys).toContain("ASK_REPORT");
    });

    test("[IF USER SKIPS] Should validate skip permission, and in Post-Onboarding Dashboard Chat ask pending optional questions then return 2 buttons", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        loginProvider: "google",
        hasSocialData: true,
        loginData: {
          firstName: { value: "John", verified: true },
          lastName: { value: "Doe", verified: true },
        },
        documentId: "doc-123",
        documentUploaded: true,
        documentExtracted: true,
        documentConfirmed: true,
        documentOwnershipConfirmed: true,
        profileConfirmed: true,
        currentStep: "ASK_BLOOD_GROUP",
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
        foundMedicines: [{ name: "Metformin 500mg", dose: "1 tablet", frequency: "ONCE_DAILY" }],
      };
      dbStates["user-101"] = state;

      // Verify skip permission
      expect(canSkipOnboarding(state)).toBe(true);

      // User skips onboarding
      state.hasSkipped = true;
      state.isOnboardingCompleted = true;
      state.fromScreen = "AIChat"; // Opened from Dashboard
      dbStates["user-101"] = state;

      // Dashboard Chat: Step 1 asks Blood Group
      let res = await onboardingService.chat("hello", [], state, "user-101");
      state = res.state;
      expect(res.action).toBe("ASK_BLOOD_GROUP");

      // Dashboard Chat: Step 2 asks Allergies
      res = await onboardingService.chat("O+", [], state, "user-101");
      state = res.state;
      expect(res.action).toBe("ASK_ALLERGIES");

      // Dashboard Chat: Step 3 returns REVIEW_MEDICINES_LIST for extracted medicines
      res = await onboardingService.chat("No allergies", [], state, "user-101");
      state = res.state;
      expect(res.action).toBe("REVIEW_MEDICINES_LIST");

      // Dashboard Chat: Step 4 Confirm Medicines
      jest.spyOn(medicationService, "bulkCreate").mockResolvedValue([{ id: "med-db-1" }]);
      res = await onboardingService.chat(
        JSON.stringify({ value: "CONFIRM" }),
        [],
        state,
        "user-101",
      );
      state = res.state;

      // Verify MEDICINE_OPTIONS returns EXACTLY 2 buttons in Dashboard Chat
      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(2);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("ASK_REPORT");
      expect(keys).not.toContain("DASHBOARD");
    });
  });

  // =========================================================================
  // FLOW 2: UPLOAD + MOBILE
  // =========================================================================
  describe("Flow 2: UPLOAD + MOBILE", () => {
    test("[IF USER DOES NOT SKIP] Should complete all onboarding steps and return 3 buttons on MEDICINE_OPTIONS", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        loginProvider: "mobile",
        hasSocialData: false,
        documentId: "doc-456",
        documentUploaded: true,
        documentExtracted: true,
        documentConfirmed: true,
        documentOwnershipConfirmed: true,
        profileConfirmed: true,
        existingUserData: {
          firstName: "Shraddha",
          lastName: "Chauhan",
          dateOfBirth: "1995-05-15",
          gender: "female",
        },
        foundMedicines: [{ name: "Paracetamol 650mg", dose: "1 tablet", frequency: "AS_NEEDED" }],
      };
      dbStates["user-102"] = state;

      // Step 1: Ask Blood Group
      state.currentStep = "ASK_BLOOD_GROUP";
      let res = await onboardingService.chat("B+", [], state, "user-102");
      state = res.state;
      expect(res.action).toBe("ASK_ALLERGIES");

      // Step 2: Ask Allergies
      res = await onboardingService.chat("Dust", [], state, "user-102");
      state = res.state;
      expect(res.action).toBe("REVIEW_MEDICINES_LIST");

      // Step 3: Confirm Medicines
      jest.spyOn(medicationService, "bulkCreate").mockResolvedValue([{ id: "med-db-2" }]);
      res = await onboardingService.chat(
        JSON.stringify({ value: "CONFIRM" }),
        [],
        state,
        "user-102",
      );

      // Verify MEDICINE_OPTIONS returns EXACTLY 3 buttons during onboarding
      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(3);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("DASHBOARD");
      expect(keys).toContain("ASK_REPORT");
    });

    test("[IF USER SKIPS] Should validate skip permission and return 2 buttons in Dashboard Chat stream", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        loginProvider: "mobile",
        hasSocialData: false,
        documentId: "doc-456",
        documentUploaded: true,
        documentExtracted: true,
        documentConfirmed: true,
        documentOwnershipConfirmed: true,
        profileConfirmed: true,
        currentStep: "ASK_BLOOD_GROUP",
        existingUserData: {
          firstName: "Shraddha",
          lastName: "Chauhan",
          dateOfBirth: "1995-05-15",
          gender: "female",
        },
        foundMedicines: [{ name: "Paracetamol 650mg", dose: "1 tablet", frequency: "AS_NEEDED" }],
      };

      expect(canSkipOnboarding(state)).toBe(true);

      state.hasSkipped = true;
      state.isOnboardingCompleted = true;
      state.fromScreen = "AIChat";
      dbStates["user-102"] = state;

      // Dashboard Chat asks BG -> Allergies -> Review Medicines -> 2 buttons
      let res = await onboardingService.chat("hello", [], state, "user-102");
      state = res.state;
      expect(res.action).toBe("ASK_BLOOD_GROUP");

      res = await onboardingService.chat("B+", [], state, "user-102");
      state = res.state;
      expect(res.action).toBe("ASK_ALLERGIES");

      res = await onboardingService.chat("Dust", [], state, "user-102");
      state = res.state;
      expect(res.action).toBe("REVIEW_MEDICINES_LIST");

      jest.spyOn(medicationService, "bulkCreate").mockResolvedValue([{ id: "med-db-2" }]);
      res = await onboardingService.chat(
        JSON.stringify({ value: "CONFIRM" }),
        [],
        state,
        "user-102",
      );

      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(2);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("ASK_REPORT");
      expect(keys).not.toContain("DASHBOARD");
    });
  });

  // =========================================================================
  // FLOW 3: MANUAL + SOCIAL
  // =========================================================================
  describe("Flow 3: MANUAL + SOCIAL", () => {
    test("[IF USER DOES NOT SKIP] Should complete required & optional steps and return 3 buttons", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "google",
        hasSocialData: true,
        loginData: {
          firstName: { value: "Alice", verified: true },
          lastName: { value: "Smith", verified: true },
          gender: { value: "female", verified: true },
          dateOfBirth: { value: "1992-08-20", verified: true },
        },
        existingUserData: {
          firstName: "Alice",
          lastName: "Smith",
          dateOfBirth: "1992-08-20",
          gender: "female",
        },
      };
      dbStates["user-103"] = state;

      state.currentStep = "ASK_BLOOD_GROUP";
      let res = await onboardingService.chat("A+", [], state, "user-103");
      state = res.state;
      expect(res.action).toBe("ASK_ALLERGIES");

      res = await onboardingService.chat("Pollen", [], state, "user-103");
      state = res.state;

      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(3);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("DASHBOARD");
      expect(keys).toContain("ASK_REPORT");
    });

    test("[IF USER SKIPS] Should validate skip permission and return 2 buttons in Dashboard Chat stream", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "google",
        hasSocialData: true,
        profileConfirmed: true,
        existingUserData: {
          firstName: "Alice",
          lastName: "Smith",
          dateOfBirth: "1992-08-20",
          gender: "female",
        },
      };

      expect(canSkipOnboarding(state)).toBe(true);

      state.hasSkipped = true;
      state.isOnboardingCompleted = true;
      state.fromScreen = "AIChat";
      dbStates["user-103"] = state;

      let res = await onboardingService.chat("hello", [], state, "user-103");
      state = res.state;
      expect(res.action).toBe("ASK_BLOOD_GROUP");

      res = await onboardingService.chat("A+", [], state, "user-103");
      state = res.state;
      expect(res.action).toBe("ASK_ALLERGIES");

      res = await onboardingService.chat("Pollen", [], state, "user-103");
      state = res.state;

      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(2);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("ASK_REPORT");
      expect(keys).not.toContain("DASHBOARD");
    });
  });

  // =========================================================================
  // FLOW 4: MANUAL + MOBILE
  // =========================================================================
  describe("Flow 4: MANUAL + MOBILE", () => {
    test("[IF USER DOES NOT SKIP] Should prompt required details, optional details, and return 3 buttons", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "mobile",
        hasSocialData: false,
        existingUserData: {},
      };
      dbStates["user-104"] = state;

      // Required Q1: First Name
      state.currentStep = "ASK_FIRST_NAME";
      let res = await onboardingService.chat("Bob", [], state, "user-104");
      state = res.state;
      expect(res.action).toBe("ASK_LAST_NAME");

      // Required Q2: Last Name
      res = await onboardingService.chat("Brown", [], state, "user-104");
      state = res.state;
      expect(res.action).toBe("ASK_DOB");

      // Required Q3: DOB
      res = await onboardingService.chat("1988-12-10", [], state, "user-104");
      state = res.state;
      expect(res.action).toBe("ASK_GENDER");

      // Required Q4: Gender
      res = await onboardingService.chat("male", [], state, "user-104");
      state = res.state;
      expect(res.action).toBe("ASK_BLOOD_GROUP");

      // Optional Q1: Blood Group
      res = await onboardingService.chat("AB+", [], state, "user-104");
      state = res.state;
      expect(res.action).toBe("ASK_ALLERGIES");

      // Optional Q2: Allergies
      res = await onboardingService.chat("None", [], state, "user-104");
      state = res.state;

      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(3);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("DASHBOARD");
      expect(keys).toContain("ASK_REPORT");
    });

    test("[IF USER SKIPS] Should validate skip permission once required details exist and return 2 buttons in Dashboard Chat stream", async () => {
      let state = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        loginProvider: "mobile",
        hasSocialData: false,
        profileConfirmed: true,
        existingUserData: {
          firstName: "Bob",
          lastName: "Brown",
          dateOfBirth: "1988-12-10",
          gender: "male",
        },
      };

      expect(canSkipOnboarding(state)).toBe(true);

      state.hasSkipped = true;
      state.isOnboardingCompleted = true;
      state.fromScreen = "AIChat";
      dbStates["user-104"] = state;

      let res = await onboardingService.chat("hello", [], state, "user-104");
      state = res.state;
      expect(res.action).toBe("ASK_BLOOD_GROUP");

      res = await onboardingService.chat("AB+", [], state, "user-104");
      state = res.state;
      expect(res.action).toBe("ASK_ALLERGIES");

      res = await onboardingService.chat("None", [], state, "user-104");
      state = res.state;

      expect(res.action).toBe("MEDICINE_OPTIONS");
      expect(res.options.length).toBe(2);
      const keys = res.options.map((o) => o.key);
      expect(keys).toContain("ADD");
      expect(keys).toContain("ASK_REPORT");
      expect(keys).not.toContain("DASHBOARD");
    });
  });
});
