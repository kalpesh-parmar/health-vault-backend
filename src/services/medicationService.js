const { errorConstants } = require("../constants/errorConstants");
const { NotFoundException } = require("../exceptions/appError");
const medicationRepository = require("../repositories/medicationRepository");
const patientRepository = require("../repositories/patientRepository");

const {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  validateSchema,
} = require("../validations");

const { calculateMedicationValues } = require("../utils/medicationCalculation");
class MedicationService {
  // create
  async createMedication(userId, payload) {
    const validData = await validateSchema(createMedicationSchema, payload);

    const patient = await patientRepository.findById(userId);

    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const { endDate, remainingQuantity, dailyConsumption } = calculateMedicationValues(validData);

    return medicationRepository.create({
      userId,
      patientCode: patient.patientCode,

      ...validData,

      endDate,
      remainingQuantity,
      dailyConsumption,
    });
  }

  // update
  async updateMedication(id, userId, payload) {
    const validData = await validateSchema(updateMedicationSchema, payload);

    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    const updatedPayload = {
      ...existingMedication,
      ...validData,
    };

    const { endDate, remainingQuantity, dailyConsumption, unit } =
      calculateMedicationValues(updatedPayload);

    return medicationRepository.updateById(id, {
      ...validData,
      endDate,
      remainingQuantity,
      dailyConsumption,
      unit,
    });
  }

  // get by id
  async getMedicationById(id, userId) {
    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return existingMedication;
  }

  //get list
  async getMedicationList(userId) {
    const medications = await medicationRepository.findAll(userId);

    return medications;
  }

  // filter list
  async listMedications(payload) {
    const filters = await validateSchema(listMedicationQuerySchema, payload || {});

    const result = await medicationRepository.findAllWithFilters(filters);

    return result;
  }

  // pagination list
  async listMedicationsPaginated(payload, userId) {
    if (!userId) {
      throw new NotFoundException(errorConstants.USER_NOT_FOUND);
    }

    const filters = await validateSchema(listMedicationQuerySchema, payload);

    const result = await medicationRepository.findAllWithPagination({
      ...filters,
      userId,
    });

    return result;
  }

  // delete
  async deleteMedication(id, userId) {
    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return medicationRepository.softDeleteById(id);
  }
}

module.exports = new MedicationService();
