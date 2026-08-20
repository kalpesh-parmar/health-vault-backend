const multer = require("multer");
const { z, ZodError } = require("zod");
const { InvalidRequestException } = require("../exceptions/appError");
const { errorConstants } = require("../constants/errorConstants");
const { env } = require("../configs/env");
const { MAX_FILE_SIZES, ALLOWED_MIME_TYPES } = require("../configs/fileConfig");

const patientIdParamSchema = z.object({
  patientId: z
    .string({ required_error: "patientId is required" })
    .uuid("Invalid patient ID format"),
});

const profileUploadFileSchema = z.object({
  mimetype: z.string().refine((val) => ALLOWED_MIME_TYPES.PATIENT_PROFILE.has(val), {
    message: "Invalid file type for profile image. Allowed types: png, jpeg, jpg, webp",
  }),
  size: z.number().max(MAX_FILE_SIZES.PATIENT_PROFILE, "Profile image size exceeds 5MB limit"),
});

const documentUploadFileSchema = z.object({
  mimetype: z.string().refine((val) => ALLOWED_MIME_TYPES.PATIENT_DOCUMENT.has(val), {
    message: "Invalid document file type. Allowed types: pdf, png, jpeg, jpg, webp, tiff",
  }),
  size: z.number().refine((val) => val <= MAX_FILE_SIZES.PATIENT_DOCUMENT, {
    message: `Document file size exceeds ${Math.round(MAX_FILE_SIZES.PATIENT_DOCUMENT / (1024 * 1024))}MB limit`,
  }),
});

const rawProfileMulter = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZES.PATIENT_PROFILE,
    files: 1,
  },
}).single("file");

const rawDocumentMulter = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZES.PATIENT_DOCUMENT,
    files: 5,
  },
}).array("files", 5);

function profileUploadMulter(req, res, next) {
  rawProfileMulter(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(
          new InvalidRequestException(
            `File size exceeds the limit of ${MAX_FILE_SIZES.PATIENT_PROFILE / (1024 * 1024)} MB`,
          ),
        );
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return next(new InvalidRequestException("PATIENT_PROFILE allows only one picture."));
      }
      return next(new InvalidRequestException(err.message || "File upload error"));
    }
    return next();
  });
}

function documentUploadMulter(req, res, next) {
  rawDocumentMulter(req, res, (err) => {
    if (err) {
      console.error("Error: document upload multer: ", err);
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(
          new InvalidRequestException(
            `File size exceeds the limit of ${MAX_FILE_SIZES.PATIENT_DOCUMENT / (1024 * 1024)} MB per file`,
          ),
        );
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return next(
          new InvalidRequestException(errorConstants.MAXIMUM_FIVE_DOCUMENT_FILES_ALLOWED),
        );
      }
      return next(new InvalidRequestException(err.message || "File upload error"));
    }
    return next();
  });
}

async function validateProfileUpload(req, _res, next) {
  try {
    try {
      req.params = await patientIdParamSchema.parseAsync(req.params);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new InvalidRequestException(error.issues[0]?.message || "Invalid patient ID");
      }
      throw error;
    }

    if (!req.file) {
      throw new InvalidRequestException("File is required");
    }

    try {
      await profileUploadFileSchema.parseAsync({
        mimetype: req.file.mimetype,
        size: req.file.size,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new InvalidRequestException(error.issues[0]?.message);
      }
      throw error;
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function validateDocumentUpload(req, _res, next) {
  try {
    const files = req.files;
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new InvalidRequestException("At least one document file is required.");
    }

    if (files.length > env.maxFilesPerUpload) {
      throw new InvalidRequestException(
        errorConstants.MAXIMUM_FIVE_DOCUMENT_FILES_ALLOWED(env.maxFilesPerUpload),
      );
    }

    for (const file of files) {
      try {
        await documentUploadFileSchema.parseAsync({
          mimetype: file.mimetype,
          size: file.size,
        });
      } catch (error) {
        if (error instanceof ZodError) {
          throw new InvalidRequestException(
            `Invalid file ${file.originalname}: ${error.issues[0]?.message}`,
          );
        }
        throw error;
      }
    }
    return next();
  } catch (error) {
    console.error("Error - Validate Document: ", error);
    return next(error);
  }
}

module.exports = {
  profileUploadFileSchema,
  documentUploadFileSchema,
  profileUploadMulter,
  documentUploadMulter,
  validateProfileUpload,
  validateDocumentUpload,
};
