const { ZodError } = require("zod");
const { InvalidRequestException } = require("../exceptions/appError");
const { emptySchema, idParamSchema, paginationQuerySchema } = require("./commonValidation");
const {
  createDocumentSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listDocumentsQuerySchema,
  retryDocumentSchema,
} = require("./documentValidation");
const { listRefillQuerySchema } = require("./refillValidation");
const {
  createPatientSchema,
  firebaseLoginSchema,
  listPatientsQuerySchema,
  refreshTokenSchema,
  updatePatientSchema,
  socialLogin,
} = require("./patientValidation");
const {
  listNotificationsPaginatedSchema,
  listNotificationsSchema,
  notificationIdParamSchema,
  testSendNotificationSchema,
  userIdBodySchema,
} = require("./notificationValidation");
const {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  refillMedicationSchema,
  medicationOnboardingSchema,
  checkDuplicateMedicationSchema,
} = require("./medicationValidation");
const {
  createReminderSchema,
  updateOccurrenceSchema,
  listOccurrencesQuerySchema,
} = require("./reminderValidation");
const { createSessionSchema } = require("./sessionValidation");
const {
  patientIdParamSchema,
  profileUploadSchema,
  documentUploadSchema,
  profileUploadMulter,
  documentUploadMulter,
  validateProfileUpload,
  validateDocumentUpload,
} = require("./uploadValidation");
const {
  jobIdParamSchema,
  validateJobIdParam,
  validateBatchJobIdsBody,
} = require("./ocrJobValidation");

function formatZodIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

async function validateSchema(schema, payload) {
  try {
    return await schema.parseAsync(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error?.issues[0]?.message;
      throw new InvalidRequestException(errorMessage);
    }

    throw error;
  }
}

module.exports = {
  createDocumentSchema,
  createPatientSchema,
  createSessionSchema,
  firebaseLoginSchema,
  emptySchema,
  formatZodIssues,
  idParamSchema,
  listDocumentsQuerySchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listPatientsQuerySchema,
  listNotificationsPaginatedSchema,
  listNotificationsSchema,
  notificationIdParamSchema,
  paginationQuerySchema,
  refreshTokenSchema,
  testSendNotificationSchema,
  updatePatientSchema,
  userIdBodySchema,
  validateSchema,
  socialLogin,
  listRefillQuerySchema,
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  createReminderSchema,
  updateOccurrenceSchema,
  listOccurrencesQuerySchema,
  refillMedicationSchema,
  medicationOnboardingSchema,
  checkDuplicateMedicationSchema,
  patientIdParamSchema,
  profileUploadSchema,
  documentUploadSchema,
  profileUploadMulter,
  documentUploadMulter,
  validateProfileUpload,
  validateDocumentUpload,
  jobIdParamSchema,
  validateJobIdParam,
  validateBatchJobIdsBody,
  retryDocumentSchema,
};
