const { ZodError } = require("zod");
const { InvalidRequestException } = require("../exceptions/appError");
const { emptySchema, idParamSchema, paginationQuerySchema } = require("./commonValidation");
const {
  createDocumentSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listDocumentsQuerySchema,
} = require("./documentValidation");
const {
  createPatientSchema,
  emailOnlySchema,
  listPatientsQuerySchema,
  loginPatientSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  updatePatientSchema,
  verifyOtpSchema,
} = require("./patientValidation");
const {
  listNotificationsPaginatedSchema,
  listNotificationsSchema,
  notificationIdParamSchema,
  testSendNotificationSchema,
  userIdBodySchema,
} = require("./notificationValidation");
const { createSessionSchema } = require("./sessionValidation");

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
  emailOnlySchema,
  emptySchema,
  formatZodIssues,
  idParamSchema,
  listDocumentsQuerySchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listPatientsQuerySchema,
  listNotificationsPaginatedSchema,
  listNotificationsSchema,
  loginPatientSchema,
  notificationIdParamSchema,
  paginationQuerySchema,
  refreshTokenSchema,
  resetPasswordSchema,
  testSendNotificationSchema,
  updatePatientSchema,
  userIdBodySchema,
  validateSchema,
  verifyOtpSchema,
};
