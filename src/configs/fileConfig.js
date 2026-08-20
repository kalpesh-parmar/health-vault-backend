const { FileCategory } = require("../enums/fileCategory");
const { env } = require("./env");

const ALLOWED_UPLOAD_TYPES = new Set(["PATIENT_PROFILE", "PATIENT_DOCUMENT"]);

const ALLOWED_MIME_TYPES = {
  PATIENT_PROFILE: new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]),
  PATIENT_DOCUMENT: new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/tiff",
  ]),
};

const MAX_FILE_SIZES = {
  PATIENT_PROFILE: 5 * 1024 * 1024, // 5 MB
  PATIENT_DOCUMENT: env.ocrMaxFileBytes || 150 * 1024 * 1024, // 150 MB
};

const UPLOAD_TYPE_TO_CATEGORY = {
  PATIENT_PROFILE: FileCategory.PROFILE,
  PATIENT_DOCUMENT: FileCategory.DOCUMENT,
};

const OCR_CONCURRENCY = Number(env.ocrConcurrency || 2);

module.exports = {
  ALLOWED_UPLOAD_TYPES,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZES,
  UPLOAD_TYPE_TO_CATEGORY,
  OCR_CONCURRENCY,
};
