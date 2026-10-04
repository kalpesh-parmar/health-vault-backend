const { FileCategory } = require("../enums/fileCategory");
const { fileType, fileTypeValue, fileExtensionValue } = require("../enums/fileType");
const { env } = require("./env");

const ALLOWED_UPLOAD_TYPES = new Set(["PATIENT_PROFILE", "PATIENT_DOCUMENT"]);

const ALLOWED_MIME_TYPES = {
  PATIENT_PROFILE: new Set([
    fileType.PNG.type,
    fileType.JPEG.type,
    fileType.JPG.type,
    fileType.WEBP.type,
  ]),
  PATIENT_DOCUMENT: new Set(fileTypeValue.filter((t) => t !== fileType.TXT.type)),
};

const ALLOWED_EXTENSION = {
  PATIENT_PROFILE: new Set([
    fileType.PNG.ext,
    fileType.JPEG.ext,
    fileType.JPG.ext,
    fileType.WEBP.ext,
  ]),
  PATIENT_DOCUMENT: new Set(fileExtensionValue.filter((e) => e !== fileType.TXT.ext)),
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
  ALLOWED_EXTENSION,
  MAX_FILE_SIZES,
  UPLOAD_TYPE_TO_CATEGORY,
  OCR_CONCURRENCY,
};
