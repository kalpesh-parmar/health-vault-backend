const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { z, ZodError } = require("zod");
const { InvalidRequestException } = require("../exceptions/appError");
const { errorConstants } = require("../constants/errorConstants");
const { env } = require("../configs/env");
const { MAX_FILE_SIZES, ALLOWED_MIME_TYPES } = require("../configs/fileConfig");
const { retryDocumentSchema } = require("./documentValidation");
const { validatePreUploadDocument } = require("../services/documentPreValidation.service");

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

const documentDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const tempDir = env.uploadTempDir || path.resolve(process.cwd(), "uploads/temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeExt = ext && ext.length <= 10 ? ext : "";
    const uniqueId = crypto.randomUUID();
    cb(null, `${uniqueId}${safeExt}`);
  },
});

const rawDocumentMulter = multer({
  storage: documentDiskStorage,
  limits: {
    fileSize: MAX_FILE_SIZES.PATIENT_DOCUMENT,
  },
}).fields([
  { name: "files" },
  { name: "file", maxCount: 1 },
]);

function profileUploadMulter(req, res, next) {
  rawProfileMulter(req, res, (err) => {
    if (err) {
      if (handleUploadAbort(req, res, err, "ProfileUpload")) {
        return;
      }
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

function handleUploadAbort(req, res, err, uploadName = "Upload") {
  const isClientAborted =
    req.aborted ||
    req.destroyed ||
    req.socket?.destroyed ||
    err?.message === "Request aborted" ||
    err?.message === "Request closed" ||
    err?.code === "ECONNABORTED";

  if (!isClientAborted) {
    return false;
  }

  console.warn(`[${uploadName}] Client aborted upload connection: ${err?.message || "Request aborted"}`);

  if (req.files && Array.isArray(req.files)) {
    for (const file of req.files) {
      if (file.path && fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch (_) {}
      }
    }
  }
  if (req.file?.path && fs.existsSync(req.file.path)) {
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) {}
  }

  if (res.headersSent || res.writableEnded || req.destroyed || req.socket?.destroyed) {
    return true;
  }

  res.status(499).json({
    success: false,
    errorCode: "CLIENT_CLOSED_REQUEST",
    message: "Upload connection was closed by client.",
    details: null,
  });
  return true;
}

function documentUploadMulter(req, res, next) {
  rawDocumentMulter(req, res, (err) => {
    if (err) {
      if (handleUploadAbort(req, res, err, "DocumentUpload")) {
        return;
      }
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
          new InvalidRequestException(
            errorConstants.MAXIMUM_FIVE_DOCUMENT_FILES_ALLOWED(env.maxFilesPerUpload || 20),
          ),
        );
      }
      return next(new InvalidRequestException(err.message || "File upload error"));
    }

    if (req.files && !Array.isArray(req.files)) {
      const filesArray = [
        ...(req.files.files || []),
        ...(req.files.file || []),
      ];
      req.files = filesArray;
      req.file = filesArray[0] || null;
    } else if (req.file && (!req.files || req.files.length === 0)) {
      req.files = [req.file];
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

      const preValidation = await validatePreUploadDocument(file);
      if (!preValidation.isValid) {
        throw new InvalidRequestException(
          `${preValidation.title}: ${preValidation.message}`,
        );
      }
    }
    return next();
  } catch (error) {
    console.error("Error - Validate Document: ", error);
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files) {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlink(file.path, () => {});
        }
      }
    }
    return next(error);
  }
}

const rawDocumentRetryMulter = multer({
  storage: documentDiskStorage,
  limits: {
    fileSize: MAX_FILE_SIZES.PATIENT_DOCUMENT,
    files: 1,
  },
}).single("file");

function documentRetryUploadMulter(req, res, next) {
  rawDocumentRetryMulter(req, res, (err) => {
    if (err) {
      if (handleUploadAbort(req, res, err, "DocumentRetryUpload")) {
        return;
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(
          new InvalidRequestException(
            `File size exceeds the limit of ${MAX_FILE_SIZES.PATIENT_DOCUMENT / (1024 * 1024)} MB per file`,
          ),
        );
      }

      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return next(new InvalidRequestException("Only one document file is allowed."));
      }

      return next(new InvalidRequestException(err.message || "File upload error"));
    }

    return next();
  });
}

async function validateDocumentRetry(req, _res, next) {
  try {
    const payload = {
      fileKey: req.body?.fileKey || req.query?.fileKey,
      batchId: req.body?.batchId || req.query?.batchId,
    };

    try {
      const parsed = await retryDocumentSchema.parseAsync(payload);
      req.validatedRetry = parsed;
      if (req.body && typeof req.body === "object") {
        req.body.fileKey = parsed.fileKey;
      }
      if (req.query && typeof req.query === "object") {
        req.query.fileKey = parsed.fileKey;
      }
    } catch (error) {
      if (error instanceof ZodError) {
        throw new InvalidRequestException(
          error.issues[0]?.message || errorConstants.FILE_KEY_REQUIRED,
        );
      }
      throw error;
    }

    if (req.file) {
      try {
        await documentUploadFileSchema.parseAsync({
          mimetype: req.file.mimetype,
          size: req.file.size,
        });
      } catch (error) {
        if (error instanceof ZodError) {
          throw new InvalidRequestException(
            `Invalid file ${req.file.originalname}: ${error.issues[0]?.message}`,
          );
        }
        throw error;
      }
    }

    return next();
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, () => {});
    }
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
  documentRetryUploadMulter,
  validateDocumentRetry,
  documentDiskStorage,
  rawDocumentMulter,
  rawDocumentRetryMulter,
};
