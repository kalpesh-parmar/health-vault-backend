const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const aiServiceClient = require("../clients/aiServiceClient");
const { MAX_FILE_SIZES } = require("./uploadFile.service");
const { parsePdf } = require("../utils/pdfParser");
const { ALLOWED_EXTENSION } = require("../configs/fileConfig");
const { validationCache, computeSha256 } = require("./cache/validationCache.service");
const { medgemmaQueue } = require("./queue/medgemmaQueue.service");
const { env } = require("../configs/env");

const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZES.PATIENT_DOCUMENT;
const SUPPORTED_EXTENSIONS = ALLOWED_EXTENSION.PATIENT_DOCUMENT;

/**
 * Checks magic bytes to verify file format integrity.
 */
function checkMagicBytes(buffer, ext) {
  if (!buffer || buffer.length < 4) {
    return false;
  }

  const normalizedExt = (ext || "").toLowerCase();

  switch (normalizedExt) {
    case "pdf": {
      // PDF must start with '%PDF-' (0x25, 0x50, 0x44, 0x46, 0x2D)
      const headerChunk = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("binary");
      return headerChunk.includes("%PDF-");
    }
    case "jpg":
    case "jpeg": {
      // JPEG starts with FF D8 FF
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    case "png": {
      // PNG starts with 89 50 4E 47 0D 0A 1A 0A
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      );
    }
    case "webp": {
      // WEBP starts with 'RIFF' at 0 and 'WEBP' at 8
      if (buffer.length < 12) return false;
      const riff = buffer.subarray(0, 4).toString("ascii");
      const webp = buffer.subarray(8, 12).toString("ascii");
      return riff === "RIFF" && webp === "WEBP";
    }
    case "tiff":
    case "tif": {
      // TIFF starts with 'II*\0' (0x49 0x49 0x2A 0x00) or 'MM\0*' (0x4D 0x4D 0x00 0x2A)
      return (
        (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
        (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
      );
    }
    case "docx": {
      // DOCX is a zip file, starts with PK\x03\x04
      return buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    }
    case "doc": {
      // Classic DOC starts with D0 CF 11 E0
      return (
        buffer[0] === 0xd0 &&
        buffer[1] === 0xcf &&
        buffer[2] === 0x11 &&
        buffer[3] === 0xe0
      );
    }
    default:
      return true;
  }
}

/**
 * Downscales an image buffer if either dimension exceeds 1536px.
 * Keeps aspect ratio and converts to optimized JPEG to minimize payload and VLM memory.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function downscaleImageIfNeeded(buffer, ext) {
  if (!["jpg", "jpeg", "png", "webp", "tiff", "tif"].includes(ext)) {
    return { buffer, mimeType: `image/${ext}` };
  }

  try {
    const metadata = await sharp(buffer).metadata();
    if (metadata && (metadata.width > 1536 || metadata.height > 1536)) {
      const resized = await sharp(buffer)
        .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      return { buffer: resized, mimeType: "image/jpeg" };
    }
  } catch {
    // If downscale fails, continue with original buffer
  }

  return { buffer, mimeType: `image/${ext}` };
}

/**
 * Validates a single document prior to upload/ingestion.
 *
 * Checks:
 * 1. Cheap pre-validation: File size (<= 25 MB, > 0 bytes)
 * 2. Cheap pre-validation: Supported extension
 * 3. Cheap pre-validation: Magic bytes / file signatures
 * 4. Cheap pre-validation: Structural integrity (PDF / Image)
 * 5. SHA-256 Cache: Skip LLM inference if identical document was already validated
 * 6. Image downscaling / first-page PDF optimization before inference
 * 7. Concurrency-queued Canonical Medical Validation via POST /v1/validation/medical
 *
 * @param {object} file - Express multer file object
 * @param {object} [options]
 * @param {boolean} [options.failOpen=true] - Whether to allow document if AI service is unavailable
 * @returns {Promise<object>}
 */
async function validatePreUploadDocument(file, options = {}) {
  const failOpen = options.failOpen !== undefined ? options.failOpen : true;

  if (!file) {
    return {
      isValid: false,
      code: "FILE_MISSING",
      title: "File couldn't be read",
      message: "This file appears to be corrupted.",
    };
  }

  const originalName = file.originalname || file.name || file.filename || "document";
  const size = file.size !== undefined ? file.size : (file.buffer ? file.buffer.length : 0);

  // 1. Cheap pre-validation: File size check
  if (size > MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      code: "FILE_TOO_LARGE",
      title: "File is too large",
      message: "Maximum allowed size is 25 MB.",
    };
  }

  if (size === 0) {
    return {
      isValid: false,
      code: "CORRUPTED_FILE",
      title: "File couldn't be read",
      message: "This file appears to be corrupted.",
    };
  }

  // 2. Cheap pre-validation: Extension check
  const ext = (path.extname(originalName) || "").replace(/^\./, "").toLowerCase();
  if (!ext || !SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      isValid: false,
      code: "UNSUPPORTED_TYPE",
      title: "Unsupported file type",
      message: "This file type isn't supported. Please select PDF, JPG, JPEG or another supported medical file type.",
    };
  }

  // Resolve buffer
  let buffer = file.buffer;
  if (!buffer && file.path && fs.existsSync(file.path)) {
    try {
      buffer = fs.readFileSync(file.path);
    } catch {
      return {
        isValid: false,
        code: "CORRUPTED_FILE",
        title: "File couldn't be read",
        message: "This file appears to be corrupted.",
      };
    }
  }

  if (!buffer || buffer.length === 0) {
    return {
      isValid: false,
      code: "CORRUPTED_FILE",
      title: "File couldn't be read",
      message: "This file appears to be corrupted.",
    };
  }

  // 3. Cheap pre-validation: Magic bytes validation
  const isValidSignature = checkMagicBytes(buffer, ext);
  if (!isValidSignature) {
    return {
      isValid: false,
      code: "CORRUPTED_FILE",
      title: "File couldn't be read",
      message: "This file appears to be corrupted.",
    };
  }

  // 4. Cheap pre-validation: Structural Integrity Check
  if (ext === "pdf") {
    try {
      await parsePdf(buffer);
    } catch {
      return {
        isValid: false,
        code: "CORRUPTED_FILE",
        title: "File couldn't be read",
        message: "This file appears to be corrupted.",
      };
    }
  }

  if (["jpg", "jpeg", "png", "webp", "tiff", "tif"].includes(ext)) {
    try {
      const metadata = await sharp(buffer).metadata();
      if (!metadata || !metadata.width || !metadata.height) {
        return {
          isValid: false,
          code: "CORRUPTED_FILE",
          title: "File couldn't be read",
          message: "This file appears to be corrupted.",
        };
      }
    } catch {
      return {
        isValid: false,
        code: "CORRUPTED_FILE",
        title: "File couldn't be read",
        message: "This file appears to be corrupted.",
      };
    }
  }

  // 5. SHA-256 result cache check: Skip LLM inference if identical document was already evaluated
  const sha256 = computeSha256(buffer);
  if (!options.skipCache) {
    const cached = validationCache.get(sha256);
    if (cached) {
      return {
        ...cached,
        sha256,
        cacheHit: true,
      };
    }
  }

  // 6. Image downscale / PDF first-page preparation before inference
  let payloadBuffer = buffer;
  let payloadMime = file.mimetype || (ext === "pdf" ? "application/pdf" : `image/${ext}`);

  if (ext !== "pdf") {
    const downscaled = await downscaleImageIfNeeded(buffer, ext);
    payloadBuffer = downscaled.buffer;
    payloadMime = downscaled.mimeType;
  }

  // 7. Queued Canonical Medical Validation via POST /v1/validation/medical
  try {
    const response = await medgemmaQueue.run(async () => {
      return await aiServiceClient.validateMedicalDocument({
        file: {
          buffer: payloadBuffer,
          originalname: originalName,
          mimetype: payloadMime,
        },
        fileName: originalName,
        mimeType: payloadMime,
        maxPages: 1, // evaluate first page only for rapid validation
        timeout: env.validationTimeoutMs || 30000,
      });
    });

    const validationData = response?.data || response;

    if (validationData && validationData.isMedical === false) {
      const result = {
        isValid: false,
        code: "NON_MEDICAL",
        title: "Not a medical document",
        message:
          validationData.reason ||
          "This file doesn't appear to be a medical document. Please remove it before continuing.",
        documentType: null,
      };
      validationCache.set(sha256, result);
      return {
        ...result,
        sha256,
        cacheHit: false,
      };
    }

    const result = {
      isValid: true,
      documentType: validationData?.documentType || "OTHER_MEDICAL_DOCUMENT",
      code: null,
      message: validationData?.reason || "Document is a valid medical document",
    };
    validationCache.set(sha256, result);
    return {
      ...result,
      sha256,
      cacheHit: false,
    };
  } catch (err) {
    const isTimeout =
      err.code === "ECONNABORTED" ||
      (err.message && err.message.toLowerCase().includes("timeout")) ||
      err.statusCode === 504;

    const isUnavailable =
      err.statusCode === 503 ||
      err.errorCode === "MEDGEMMA_UNAVAILABLE" ||
      err.code === "ECONNREFUSED" ||
      (err.message && (err.message.includes("503") || err.message.includes("refused") || err.message.includes("unavailable")));

    console.warn(
      `[documentPreValidation] AI medical validation error for "${originalName}": ${err.message}`
    );

    if (failOpen) {
      return {
        isValid: true,
        documentType: "OTHER_MEDICAL_DOCUMENT",
        code: null,
        message: "AI validation temporarily unavailable; permitted via fail-open.",
        sha256,
        cacheHit: false,
      };
    }

    if (isTimeout) {
      return {
        isValid: false,
        code: "MODEL_TIMEOUT",
        title: "Validation Timeout",
        message: "Medical document validation timed out. Please retry.",
        sha256,
        cacheHit: false,
      };
    }

    if (isUnavailable) {
      return {
        isValid: false,
        code: "MODEL_UNAVAILABLE",
        title: "Model Unavailable",
        message: "Medical validation service is currently unavailable.",
        sha256,
        cacheHit: false,
      };
    }

    return {
      isValid: false,
      code: "MODEL_ERROR",
      title: "Validation Error",
      message: err.message || "Failed to validate document with AI model.",
      sha256,
      cacheHit: false,
    };
  }
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  SUPPORTED_EXTENSIONS,
  validatePreUploadDocument,
  checkMagicBytes,
  downscaleImageIfNeeded,
  validationCache,
};
