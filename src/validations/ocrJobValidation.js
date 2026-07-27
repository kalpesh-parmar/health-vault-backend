const { z, ZodError } = require("zod");
const { InvalidRequestException } = require("../exceptions/appError");

const jobIdParamSchema = z.object({
  jobId: z.string({ required_error: "jobId is required" }).uuid("Invalid job ID format"),
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

module.exports = {
  jobIdParamSchema,
  validateJobIdParam,
};
