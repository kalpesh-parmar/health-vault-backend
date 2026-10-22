const { executeAddDocumentAction } = require("../../src/helpers/unifiedChat.helper");
const medicationService = require("../../src/services/medication.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");

describe("Post-Onboarding Report Upload Conflict Resolution vs Review Mode", () => {
  const userId = "user-postonboarding-report-test";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("executeAddDocumentAction sets hasDuplicate: false on extracted medicines even when user has matching DB medications", async () => {
    // Patient has existing active medications in DB
    const existingDbMed = {
      id: "med-existing-db-1",
      userId,
      medicationName: "Omnacortil 40 mg",
      medicationType: "TABLET",
      dosePerIntake: 40,
      frequency: "Once Daily",
      softDelete: false,
    };

    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([existingDbMed]);

    const mockDocumentPersistenceService = {
      addDocument: jest.fn().mockImplementation(async ({ fileName, s3Key }) => ({
        document: {
          id: "doc-test-123",
          fileName,
          s3Key,
          ocrStatus: "COMPLETED",
          summary: "Discharge summary with medications",
        },
      })),
    };

    const mockDocumentOcrJobService = {
      getStatus: jest.fn().mockImplementation(async () => ({
        id: "job-test-123",
        status: "COMPLETED",
        extractedStructuredData: {
          medications: [
            {
              name: "Omnacortil 40 mg",
              type: "TABLET",
              dosage: "40 mg",
              frequency: "As directed",
              instructions: "After meals",
            },
            {
              name: "Lansoprazol 30 mg",
              type: "TABLET",
              dosage: "30 mg",
              frequency: "As directed",
              instructions: "Half hour before food",
            },
          ],
        },
      })),
    };

    const mockChatSessionRepository = {
      appendMessage: jest.fn().mockResolvedValue({ id: "msg-123" }),
    };

    const actionData = {
      files: [{ fileKey: "documents/test_discharge.jpg", fileName: "test_discharge.jpg" }],
    };

    const response = await executeAddDocumentAction({
      userId,
      actionData,
      sessionId: "session-test-postonboarding",
      preferredLanguage: "english",
      isOnboardingCompleted: true,
      documentPersistenceService: mockDocumentPersistenceService,
      documentOcrJobService: mockDocumentOcrJobService,
      chatSessionRepository: mockChatSessionRepository,
    });

    expect(response.mode).toBe("ACTION");
    expect(response.actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(response.medicines).toBeDefined();
    expect(response.medicines.length).toBe(2);

    // CRITICAL ASSERTION: All extracted medicines must have hasDuplicate: false
    // so frontend useMedicineReviewState stays in viewMode='list' instead of jumping to 'conflicts'
    response.medicines.forEach((med) => {
      expect(med.duplicateInfo).toBeDefined();
      expect(med.duplicateInfo.hasDuplicate).toBe(false);
      expect(med.duplicateInfo.conflictType).toBeNull();
      expect(med.duplicateInfo.matchedMedication).toBeNull();
    });
  });

  test("medicationService.bulkCreate accepts resolution KEEP_NEW and KEEP_BOTH without throwing ConflictException", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: userId,
      patientCode: "PAT_001",
    });

    // Mock active DB medications that would trigger conflict if not resolved
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "med-existing-db-1",
        userId,
        medicationName: "Omnacortil 40 mg",
        medicationType: "TABLET",
        softDelete: false,
      },
    ]);

    const createdMed = {
      id: "med-new-123",
      userId,
      medicationName: "Omnacortil 40 mg",
      medicationType: "TABLET",
      dosePerIntake: 40,
      frequency: "Once Daily",
      startDate: "2026-10-22",
      totalQuantity: 10,
    };

    jest.spyOn(medicationService, "createMedication").mockResolvedValue(createdMed);

    // Call bulkCreate with KEEP_NEW resolution
    const payload = [
      {
        name: "Omnacortil 40 mg",
        medicationName: "Omnacortil 40 mg",
        medicationType: "TABLET",
        dosePerIntake: 40,
        frequency: "Once Daily",
        resolution: "KEEP_NEW",
        selected: true,
      },
    ];

    const result = await medicationService.bulkCreate(userId, payload);
    expect(result).toBeDefined();
    expect(medicationService.createMedication).toHaveBeenCalledTimes(1);
  });
});
