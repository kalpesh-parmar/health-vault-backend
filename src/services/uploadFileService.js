/**
 * Generic object-storage helper used for non-document uploads (e.g. patient profile
 * pictures). Document uploads MUST go through `/documents/upload` →
 * `documentUploadService` so the new OCR flow can attach correctly.
 *
 * The `uploadType` form field used to accept `PATIENT_DOCUMENT` here.
 * After the refactor we explicitly reject that value to avoid a second,
 * duplicate code path that bypassed multipart validation, mime-type
 * checks, and the documents/run-ocr lifecycle.
 */

const { messageConstants } = require("../constants/messageConstants");
const { folderType } = require("../enums/s3Folder");
const { InvalidRequestException } = require("../exceptions/appError");
const objectStorageService = require("./objectStorageService");

const ALLOWED_UPLOAD_TYPES = new Set(["PATIENT_PROFILE"]);

class UploadFileService {
  async uploadFile(file, uploadType) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!ALLOWED_UPLOAD_TYPES.has(uploadType)) {
      throw new InvalidRequestException(
        "This endpoint only accepts non-document uploads. Use POST /documents/upload for medical documents.",
      );
    }
    const folder = folderType[uploadType];
    if (!folder) {
      throw new InvalidRequestException(messageConstants.INVALID_UPLOAD_TYPE);
    }
    const upload = await objectStorageService.uploadFile(file, folder);
    return { upload };
  }

  async deleteFile(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILEKEY_REQUIRED);
    }
    await objectStorageService.deleteFile(fileKey);
    return { message: messageConstants.FILE_DELETED };
  }

  async getSignedUrl(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILEKEY_REQUIRED);
    }
    const signedUrl = await objectStorageService.getSignedFileUrl(fileKey);
    return { signedUrl };
  }
}

module.exports = new UploadFileService();
