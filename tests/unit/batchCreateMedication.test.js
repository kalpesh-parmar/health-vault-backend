const medicationController = require("../../src/controllers/medication.controller");
const medicationService = require("../../src/services/medication.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const medicationReminderService = require("../../src/services/medicationReminder.service");
const { batchCreateMedicationSchema, validateSchema } = require("../../src/validations");
const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../../src/constants/messageConstants");
const {
  InvalidRequestException,
  NotFoundException,
  ConflictException,
} = require("../../src/exceptions/appError");
const { frequencyType } = require("../../src/enums/frequencyType");

describe("Batch Create Medications Unit Tests", () => {
  const mockUserId = "123e4567-e89b-12d3-a456-426614174000";

  beforeEach(() => {
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("batchCreateMedicationSchema Validation", () => {
    test("should validate direct array of medications", async () => {
      const payload = [
        {
          medicationName: "Paracetamol 500mg",
          medicationType: "TABLET",
          frequency: frequencyType.ONCE_DAILY,
          startDate: "2026-10-22",
          totalQuantity: 10,
        },
      ];

      const validated = await validateSchema(batchCreateMedicationSchema, payload);
      expect(Array.isArray(validated)).toBe(true);
      expect(validated.length).toBe(1);
      expect(validated[0].medicationName).toBe("Paracetamol 500mg");
    });

    test("should validate and transform object with medications property to array", async () => {
      const payload = {
        medications: [
          {
            medicationName: "Amoxicillin 250mg",
            medicationType: "CAPSULE",
            frequency: frequencyType.TWICE_DAILY,
            startDate: "2026-10-22",
            totalQuantity: 20,
          },
        ],
      };

      const validated = await validateSchema(batchCreateMedicationSchema, payload);
      expect(Array.isArray(validated)).toBe(true);
      expect(validated.length).toBe(1);
      expect(validated[0].medicationName).toBe("Amoxicillin 250mg");
    });

    test("should throw InvalidRequestException when medications array is empty", async () => {
      await expect(validateSchema(batchCreateMedicationSchema, [])).rejects.toThrow(
        InvalidRequestException,
      );
    });

    test("should throw InvalidRequestException when medication item is missing name", async () => {
      const payload = [
        {
          medicationType: "TABLET",
          frequency: frequencyType.ONCE_DAILY,
        },
      ];

      await expect(validateSchema(batchCreateMedicationSchema, payload)).rejects.toThrow(
        InvalidRequestException,
      );
    });

    test("should throw InvalidRequestException when frequency contains a typo (e.g. TWCE_DAILY)", async () => {
      const payload = [
        {
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          frequency: "TWCE_DAILY",
          startDate: "2026-10-22",
          totalQuantity: 30,
        },
      ];

      await expect(validateSchema(batchCreateMedicationSchema, payload)).rejects.toThrow(
        InvalidRequestException,
      );
    });

    test("should throw InvalidRequestException when startDate is in the past", async () => {
      const payload = [
        {
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          frequency: frequencyType.TWICE_DAILY,
          startDate: "2026-05-12",
          totalQuantity: 30,
        },
      ];

      await expect(validateSchema(batchCreateMedicationSchema, payload)).rejects.toThrow(
        InvalidRequestException,
      );
    });

    test("should throw InvalidRequestException when frequency does not match schedule times count", async () => {
      const payload = [
        {
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          frequency: frequencyType.TWICE_DAILY,
          medicationSchedule: {
            Custom: ["09:00:00"],
          },
          startDate: "2026-10-22",
          totalQuantity: 30,
        },
      ];

      await expect(validateSchema(batchCreateMedicationSchema, payload)).rejects.toThrow(
        "Twice Daily requires exactly 2 medication time(s)",
      );
    });

    test("should normalize string 'TWICE_DAILY' and throw error when only single CUSTOM time string is provided", async () => {
      const payload = [
        {
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          frequency: "TWICE_DAILY",
          startDate: "2026-10-22",
          medicationSchedule: {
            CUSTOM: "17:15:00",
          },
          foodFrequency: "BEFORE_FOOD",
          totalQuantity: 5,
          dosePerIntake: 1,
        },
      ];

      await expect(validateSchema(batchCreateMedicationSchema, payload)).rejects.toThrow(
        "Twice Daily requires exactly 2 medication time(s)",
      );
    });

    test("should normalize string 'TWICE_DAILY' and succeed when 2 custom times are provided", async () => {
      const payload = [
        {
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          frequency: "TWICE_DAILY",
          startDate: "2026-10-22",
          medicationSchedule: {
            CUSTOM: ["17:15:00", "22:00:00"],
          },
          foodFrequency: "BEFORE_FOOD",
          totalQuantity: 5,
          dosePerIntake: 1,
        },
      ];

      const validated = await validateSchema(batchCreateMedicationSchema, payload);
      expect(validated[0].frequency).toBe("Twice Daily");
      expect(validated[0].medicationSchedule.Custom).toEqual(["17:15:00", "22:00:00"]);
    });
  });

  describe("medicationController.batchCreateMedications", () => {
    test("should call medicationService.bulkCreate and return 201 with success response", async () => {
      const mockResult = [
        { id: "med-1", medicationName: "Paracetamol 500mg" },
        { id: "med-2", medicationName: "Ibuprofen 400mg" },
      ];
      mockResult.created = mockResult;
      mockResult.createdCount = 2;

      jest.spyOn(medicationService, "bulkCreate").mockResolvedValue(mockResult);

      const req = {
        auth: { userId: mockUserId },
        body: [{ medicationName: "Paracetamol 500mg" }, { medicationName: "Ibuprofen 400mg" }],
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await medicationController.batchCreateMedications(req, res);

      expect(medicationService.bulkCreate).toHaveBeenCalledWith(mockUserId, req.body);
      expect(res.status).toHaveBeenCalledWith(StatusCodes.CREATED);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockResult,
          status: expect.objectContaining({
            description: messageConstants.MEDICATIONS_BATCH_CREATED,
            statusCode: StatusCodes.CREATED,
          }),
        }),
      );
    });
  });

  describe("medicationService.bulkCreate Integration", () => {
    test("should create medications and create reminders for each created medication", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const createMedSpy = jest
        .spyOn(medicationService, "createMedication")
        .mockResolvedValueOnce({ id: "med-batch-1", medicationName: "Paracetamol 500mg" })
        .mockResolvedValueOnce({ id: "med-batch-2", medicationName: "Metformin 500mg" });

      const createReminderSpy = jest
        .spyOn(medicationReminderService, "createReminder")
        .mockResolvedValue({ id: "rem-1" });

      const payload = [
        {
          medicationName: "Paracetamol 500mg",
          medicationType: "TABLET",
          frequency: "Once Daily",
          startDate: "2026-10-22",
          totalQuantity: 10,
        },
        {
          medicationName: "Metformin 500mg",
          medicationType: "TABLET",
          frequency: "Twice Daily",
          startDate: "2026-10-22",
          totalQuantity: 20,
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);

      expect(patientRepository.findById).toHaveBeenCalledWith(mockUserId);
      expect(createMedSpy).toHaveBeenCalledTimes(2);
      expect(createReminderSpy).toHaveBeenCalledTimes(2);
      expect(result.createdCount).toBe(2);
      expect(result.length).toBe(2);
      expect(result[0].id).toBe("med-batch-1");
      expect(result[1].id).toBe("med-batch-2");
    });

    test("should throw ConflictException with structured conflict details when a duplicate is added without resolution", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const existingMed = {
        id: "existing-med-uuid-1",
        userId: mockUserId,
        medicationName: "Paracetamol 500mg",
        medicationType: "TABLET",
      };

      jest.spyOn(medicationRepository, "findAll").mockResolvedValue([existingMed]);

      const payload = [
        {
          medicationName: "Paracetamol 500mg",
          medicationType: "TABLET",
          frequency: "Once Daily",
          startDate: "2026-10-22",
          totalQuantity: 10,
        },
      ];

      try {
        await medicationService.bulkCreate(mockUserId, payload);
        throw new Error("Should have thrown ConflictException");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.statusCode).toBe(StatusCodes.CONFLICT);
        expect(err.errorCode).toBe("CONFLICT");
        expect(err.details).toBeDefined();
        expect(err.details.duplicateInfo).toBeDefined();
        expect(err.details.duplicateInfo.existingMedicationId).toBe("existing-med-uuid-1");
        expect(err.details.duplicateInfo.existingMedicationName).toBe("Paracetamol 500mg");
        expect(err.details.suggestedActions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ action: "KEEP EXISTING" }),
            expect.objectContaining({ action: "REPLACE" }),
            expect.objectContaining({ action: "EDIT" }),
            expect.objectContaining({ action: "REMOVE NEW" }),
          ]),
        );
      }
    });

    test("should replace existing medication when resolution is REPLACE", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const deleteMedSpy = jest
        .spyOn(medicationService, "deleteMedication")
        .mockResolvedValue({ success: true });

      const createMedSpy = jest
        .spyOn(medicationService, "createMedication")
        .mockResolvedValue({ id: "med-replaced-1", medicationName: "Paracetamol 500mg" });

      jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({ id: "rem-1" });

      const payload = [
        {
          medicationName: "Paracetamol 500mg",
          medicationType: "TABLET",
          frequency: "Once Daily",
          startDate: "2026-10-22",
          totalQuantity: 10,
          resolution: "REPLACE",
          replaceMedicationId: "existing-med-uuid-1",
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);

      expect(deleteMedSpy).toHaveBeenCalledWith("existing-med-uuid-1", mockUserId);
      expect(createMedSpy).toHaveBeenCalledTimes(1);
      expect(result.createdCount).toBe(1);
      expect(result[0].id).toBe("med-replaced-1");
    });

    test("should keep existing medication when resolution is KEEP_EXISTING", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const createMedSpy = jest.spyOn(medicationService, "createMedication");

      const payload = [
        {
          medicationName: "Paracetamol 500mg",
          resolution: "KEEP_EXISTING",
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);

      expect(createMedSpy).not.toHaveBeenCalled();
      expect(result.createdCount).toBe(0);
      expect(result.keptCount).toBe(1);
    });

    test("should keep existing medication and not add to DB when resolution has a space 'KEEP EXISTING'", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const createMedSpy = jest.spyOn(medicationService, "createMedication");

      const payload = [
        {
          medicationName: "Paracetamol 500mg",
          resolution: "KEEP EXISTING",
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);

      expect(createMedSpy).not.toHaveBeenCalled();
      expect(result.createdCount).toBe(0);
      expect(result.keptCount).toBe(1);
    });

    test("should keep existing medication and not add to DB when action is 'KEEP EXISTING'", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const createMedSpy = jest.spyOn(medicationService, "createMedication");

      const payload = [
        {
          medicationName: "Paracetamol 500mg",
          action: "KEEP EXISTING",
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);

      expect(createMedSpy).not.toHaveBeenCalled();
      expect(result.createdCount).toBe(0);
      expect(result.keptCount).toBe(1);
    });

    test("should detect exact/normalized duplicate conflict and throw ConflictException", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const existingMed = {
        id: "existing-med-uuid-2",
        medicationName: "Paracetamol 500mg",
        medicationType: "TABLET",
      };

      jest.spyOn(medicationRepository, "findAll").mockResolvedValue([existingMed]);

      const payload = [
        {
          medicationName: "Tab. Paracetamol 500mg",
          medicationType: "TABLET",
          frequency: "Once Daily",
          startDate: "2026-10-22",
          totalQuantity: 10,
        },
      ];

      try {
        await medicationService.bulkCreate(mockUserId, payload);
        throw new Error("Should have thrown ConflictException");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.statusCode).toBe(StatusCodes.CONFLICT);
        expect(err.details.duplicateInfo.hasDuplicate).toBe(true);
        expect(err.details.duplicateInfo.matchedMedication.medicationName).toBe(
          "Paracetamol 500mg",
        );
      }
    });

    test("should detect substring similarity conflict (Metformin in Metformin ER) and throw ConflictException", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const existingMed = {
        id: "existing-med-uuid-3",
        medicationName: "Metformin ER 500mg",
        medicationType: "TABLET",
      };

      jest.spyOn(medicationRepository, "findAll").mockResolvedValue([existingMed]);

      const payload = [
        {
          medicationName: "Metformin 500mg",
          medicationType: "TABLET",
          frequency: "Once Daily",
          startDate: "2026-10-22",
          totalQuantity: 10,
        },
      ];

      try {
        await medicationService.bulkCreate(mockUserId, payload);
        throw new Error("Should have thrown ConflictException");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.statusCode).toBe(StatusCodes.CONFLICT);
        expect(err.details.duplicateInfo.hasDuplicate).toBe(true);
        expect(err.details.duplicateInfo.matchedMedication.medicationName).toBe(
          "Metformin ER 500mg",
        );
      }
    });

    test("createMedication should not add to DB when resolution is KEEP EXISTING", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const existingMed = {
        id: "existing-med-uuid-4",
        medicationName: "Paracetamol 500mg",
        medicationType: "TABLET",
      };

      jest.spyOn(medicationRepository, "findAll").mockResolvedValue([existingMed]);
      const createRepoSpy = jest.spyOn(medicationRepository, "create");

      const payload = {
        medicationName: "Paracetamol 500mg",
        medicationType: "TABLET",
        frequency: "Once Daily",
        startDate: "2026-10-22",
        totalQuantity: 10,
        resolution: "KEEP EXISTING",
      };

      const result = await medicationService.createMedication(mockUserId, payload);

      expect(createRepoSpy).not.toHaveBeenCalled();
      expect(result.id).toBe("existing-med-uuid-4");
    });

    test("should preserve 2 custom times for Twice Daily without adding default Night", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });
      const createRepoSpy = jest
        .spyOn(medicationRepository, "create")
        .mockImplementation((data) => Promise.resolve({ id: "med-custom-twice", ...data }));
      jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({});

      const payload = [
        {
          medicationName: "Custom Twice Med",
          medicationType: "TABLET",
          frequency: "Twice Daily",
          medicationSchedule: {
            CUSTOM: ["10:15:00", "16:45:00"],
          },
          startDate: "2026-10-22",
          totalQuantity: 20,
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);
      expect(result.length).toBe(1);
      expect(createRepoSpy).toHaveBeenCalled();
      const savedSchedule = createRepoSpy.mock.calls[0][0].medicationSchedule;
      expect(savedSchedule.Custom).toEqual(["10:15:00", "16:45:00"]);
      expect(savedSchedule.Night).toBeUndefined();
      expect(savedSchedule.Noon).toBeUndefined();
    });

    test("should throw validation error when custom times count does not match frequency for Twice Daily", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });

      const payload = [
        {
          medicationName: "Custom Twice 1 Time",
          medicationType: "TABLET",
          frequency: "Twice Daily",
          medicationSchedule: {
            Custom: ["10:00:00"],
          },
          startDate: "2026-10-22",
          totalQuantity: 20,
        },
      ];

      await expect(medicationService.bulkCreate(mockUserId, payload)).rejects.toThrow(
        "Twice Daily requires exactly 2 medication time(s)",
      );
    });

    test("should parse CUSTOME with comma-separated string array and preserve exact custom times for Twice Daily", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });
      const createRepoSpy = jest
        .spyOn(medicationRepository, "create")
        .mockImplementation((data) => Promise.resolve({ id: "med-custome-comma", ...data }));
      jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({});

      const payload = [
        {
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          frequency: frequencyType.TWICE_DAILY,
          medicationSchedule: {
            CUSTOME: ["09:00:00, 22:00:00"],
          },
          startDate: "2026-10-22",
          totalQuantity: 30,
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);
      expect(result.length).toBe(1);
      const savedSchedule = createRepoSpy.mock.calls[0][0].medicationSchedule;
      expect(savedSchedule.Custom).toEqual(["09:00:00", "22:00:00"]);
      expect(savedSchedule.Morning).toBeUndefined();
    });

    test("should handle user scenario: REPLACE with valid Twice Daily, CUSTOME times, and valid future startDate", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });
      const deleteMedSpy = jest
        .spyOn(medicationService, "deleteMedication")
        .mockResolvedValue({ id: "123e4567-e89b-12d3-a456-426614174000" });
      const createRepoSpy = jest
        .spyOn(medicationRepository, "create")
        .mockImplementation((data) =>
          Promise.resolve({ id: "1e269d36-c36b-4a1d-8a63-a2a43182e230", ...data }),
        );
      jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({});

      const payload = [
        {
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          prescribedBy: "Dr. Smith",
          dosePerIntake: 1,
          frequency: frequencyType.TWICE_DAILY,
          medicationSchedule: {
            CUSTOME: ["09:00:00, 22:00:00"],
          },
          foodFrequency: "BEFORE_FOOD",
          startDate: "2026-10-22",
          ongoing: false,
          totalQuantity: 30,
          reminderBeforeMinutes: 10,
          notes: "Take after food",
          resolution: "REPLACE",
          replaceMedicationId: "123e4567-e89b-12d3-a456-426614174000",
        },
      ];

      const validated = await validateSchema(batchCreateMedicationSchema, payload);
      const result = await medicationService.bulkCreate(mockUserId, validated);

      expect(result.length).toBe(1);
      expect(deleteMedSpy).toHaveBeenCalledWith("123e4567-e89b-12d3-a456-426614174000", mockUserId);
      const savedData = createRepoSpy.mock.calls[0][0];
      expect(savedData.frequency).toBe("Twice Daily");
      expect(savedData.medicationSchedule).toEqual({
        Custom: ["09:00:00", "22:00:00"],
      });
      expect(savedData.foodFrequency).toBe("BEFORE_FOOD");
    });

    test("should preserve 3 custom times for Three Times Daily without adding Noon or Night defaults", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        patientCode: "PAT123",
      });
      const createRepoSpy = jest
        .spyOn(medicationRepository, "create")
        .mockImplementation((data) => Promise.resolve({ id: "med-custom-thrice", ...data }));
      jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({});

      const payload = [
        {
          medicationName: "Custom Thrice Med",
          medicationType: "TABLET",
          frequency: "Three Times Daily",
          medicationSchedule: {
            CUSTOM: ["07:30:00", "13:30:00", "19:30:00"],
          },
          startDate: "2026-10-22",
          totalQuantity: 30,
        },
      ];

      const result = await medicationService.bulkCreate(mockUserId, payload);
      expect(result.length).toBe(1);
      const savedSchedule = createRepoSpy.mock.calls[0][0].medicationSchedule;
      expect(savedSchedule.Custom).toEqual(["07:30:00", "13:30:00", "19:30:00"]);
      expect(savedSchedule.Noon).toBeUndefined();
      expect(savedSchedule.Night).toBeUndefined();
    });

    test("should throw NotFoundException if patient does not exist", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue(null);

      await expect(
        medicationService.bulkCreate(mockUserId, [{ medicationName: "Paracetamol" }]),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
