/**
 * Strict "upload only" service for the new flow.
 *
 * Returns:  { fileKey, originalName, mimeType, size, uploadedAt }
 * Does NOT touch the database.
 * Does NOT call OCR or AI.
 *
 * MIME validation is enforced here so the API rejects junk before it
 * reaches configured object storage. The size limit is enforced earlier by `multer`.
 */

const { messageConstants } = require("../constants/messageConstants");
const { folderType } = require("../enums/s3Folder");
const { InvalidRequestException } = require("../exceptions/appError");
const objectStorageService = require("./objectStorageService");

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

class DocumentUploadService {
  async uploadDocument(file) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new InvalidRequestException("Only PDF, PNG, JPG, JPEG, and WEBP files are supported");
    }

    const folder = folderType.PATIENT_DOCUMENT;
    const upload = await objectStorageService.uploadFile(file, folder);

    return {
      fileKey: upload.fileKey,
      mimeType: upload.fileType || file.mimetype,
      originalName: upload.fileName || file.originalname,
      size: upload.fileSize || file.size,
      storageProvider: upload.storageProvider || objectStorageService.getProviderName(),
      uploadedAt: new Date().toISOString(),
    };
  }
}

module.exports = new DocumentUploadService();
