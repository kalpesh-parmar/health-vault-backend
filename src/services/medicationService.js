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

class MedicationService {
  async createMedication(userId, payload) {
    const validData = await validateSchema(createMedicationSchema, payload);

    const patient = await patientRepository.findById(userId);

    return medicationRepository.create({
      userId,
      patientCode: patient.patientCode,
      ...validData,
    });
  }

  async updateMedication(id, userId, payload) {
    const validData = await validateSchema(updateMedicationSchema, payload);

    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || existingMedication.userId !== userId) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return medicationRepository.updateById(id, validData);
  }

  async getMedicationById(id, userId) {
    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || existingMedication.userId !== userId) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return existingMedication;
  }

  async getMedicationList(userId) {
    const medications = await medicationRepository.findAll(userId);

    return medications;
  }

  async listMedications(payload) {
    const filters = await validateSchema(listMedicationQuerySchema, payload || {});

    return medicationRepository.findAllWithFilters(filters);
  }

  async listMedicationsPaginated(payload) {
    const filters = await validateSchema(listMedicationQuerySchema, payload);

    return medicationRepository.findAllWithPagination(filters);
  }

  async deleteMedication(id, userId) {
    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || existingMedication.userId !== userId) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return medicationRepository.softDeleteById(id);
  }
}

module.exports = new MedicationService();
