const { z, ZodError } = require("zod");
const { InvalidRequestException } = require("../exceptions/appError");

const jobIdParamSchema = z.object({
  jobId: z.string({ required_error: "jobId is required" }).uuid("Invalid job ID format"),
});

const batchJobIdsSchema = z.object({
  jobIds: z
    .array(z.string().uuid("Invalid job ID format"), {
      required_error: "jobIds array is required",
    })
    .min(1, "jobIds array must contain at least 1 job ID")
    .max(50, "jobIds array cannot exceed 50 job IDs"),
});

async function validateJobIdParam(req, _res, next) {
  try {
    try {
      req.params = await jobIdParamSchema.parseAsync(req.params);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new InvalidRequestException(error.issues[0]?.message || "Invalid job ID format");
      }
      throw error;
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

async function validateBatchJobIdsBody(req, _res, next) {
  try {
    try {
      req.body = await batchJobIdsSchema.parseAsync(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new InvalidRequestException(
          error.issues[0]?.message || "Invalid batch job IDs request",
        );
      }
      throw error;
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  jobIdParamSchema,
  batchJobIdsSchema,
  validateJobIdParam,
  validateBatchJobIdsBody,
};
