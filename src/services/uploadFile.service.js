const {
  MAX_FILE_SIZES,
  ALLOWED_UPLOAD_TYPES,
  UPLOAD_TYPE_TO_CATEGORY,
  ALLOWED_MIME_TYPES,
} = require("../configs/fileConfig");
const { messageConstants } = require("../constants/messageConstants");
const { InvalidRequestException } = require("../exceptions/appError");
const objectStorageService = require("./objectStorage.service");

class UploadFileService {
  async uploadFile(file, uploadType, patientId) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED || "File is required");
    }
    if (!uploadType || !ALLOWED_UPLOAD_TYPES.has(uploadType)) {
      throw new InvalidRequestException(
        `Invalid uploadType. Allowed values: ${Array.from(ALLOWED_UPLOAD_TYPES).join(", ")}`,
      );
    }

    // Mime-type validation
    const allowedMimes = ALLOWED_MIME_TYPES[uploadType];
    if (!allowedMimes.has(file.mimetype)) {
      throw new InvalidRequestException(
        `Invalid file type for ${uploadType}. Supported types: ${Array.from(allowedMimes).join(", ")}`,
      );
    }

    // File size validation
    const maxSize = MAX_FILE_SIZES[uploadType];
    if (file.size > maxSize) {
      throw new InvalidRequestException(
        `File size exceeds the limit of ${maxSize / (1024 * 1024)} MB`,
      );
    }

    const category = UPLOAD_TYPE_TO_CATEGORY[uploadType];
    if (!category) {
      throw new InvalidRequestException(
        messageConstants.INVALID_UPLOAD_TYPE || "Invalid upload type mapping",
      );
    }

    const upload = await objectStorageService.uploadFile(file, category, patientId);
    const signedUrl = await objectStorageService.getSignedFileUrl(upload.fileKey);

    return {
      isMedicalDocument: true,
      fileKey: upload.fileKey,
      originalFileName: upload.fileName || file.originalname,
      mimeType: upload.fileType || file.mimetype,
      fileSize: upload.fileSize || file.size,
      fileUrl: signedUrl,
      data: {
        fileKey: upload.fileKey,
        originalFileName: upload.fileName || file.originalname,
        mimeType: upload.fileType || file.mimetype,
        fileSize: upload.fileSize || file.size,
        fileUrl: signedUrl,
      },
    };
  }

  async deleteFile(query) {
    const fileKey = query.fileKey;
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILEKEY_REQUIRED || "fileKey is required");
    }
    await objectStorageService.deleteFile(fileKey);
    return { message: messageConstants.FILE_DELETED };
  }

  async getFileStream(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILEKEY_REQUIRED || "fileKey is required");
    }
    return objectStorageService.getFileStream(fileKey);
  }
}

module.exports = new UploadFileService();
module.exports.UploadFileService = UploadFileService;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;
module.exports.MAX_FILE_SIZES = MAX_FILE_SIZES;
