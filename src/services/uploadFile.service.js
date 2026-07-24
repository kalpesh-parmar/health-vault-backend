const { messageConstants } = require("../constants/messageConstants");
const { FileCategory } = require("../enums/fileCategory");
const { InvalidRequestException, NonMedicalDocumentException } = require("../exceptions/appError");
const objectStorageService = require("./objectStorage.service");

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
  PATIENT_DOCUMENT: 150 * 1024 * 1024, // 150 MB
};

const UPLOAD_TYPE_TO_CATEGORY = {
  PATIENT_PROFILE: FileCategory.PROFILE,
  PATIENT_DOCUMENT: FileCategory.DOCUMENT,
};

class UploadFileService {
  async uploadFile(file, uploadType, patientId) {
    console.log("upload");

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

    if (uploadType === "PATIENT_DOCUMENT") {
      // Kept in-method to prevent circular dependency: ./ai -> ./ocr/ocr.service -> uploadFileService
      const { ocrService } = require("./ai");

      const validation = await ocrService.validateDocument({
        buffer: file.buffer,
        mimeType: file.mimetype,
        filename: file.originalname,
      });

      if (validation.status === "FAILED") {
        throw new InvalidRequestException(
          validation.error || validation.reason || "AI response format is invalid.",
        );
      }

      if (!validation.isMedicalDocument) {
        throw new NonMedicalDocumentException(
          validation.reason || "The uploaded file is not a medical document.",
        );
      }

      const upload = await objectStorageService.uploadFile(file, category, patientId);
      const signedUrl = await objectStorageService.getSignedFileUrl(upload.fileKey);

      return {
        isMedicalDocument: true,
        documentType: validation.documentType,
        data: {
          fileKey: upload.fileKey,
          originalFileName: upload.fileName || file.originalname,
          mimeType: upload.fileType || file.mimetype,
          fileSize: upload.fileSize || file.size,
          fileUrl: signedUrl,
        },
      };
    }

    const upload = await objectStorageService.uploadFile(file, category, patientId);
    const signedUrl = await objectStorageService.getSignedFileUrl(upload.fileKey);

    return {
      fileKey: upload.fileKey,
      originalFileName: upload.fileName || file.originalname,
      mimeType: upload.fileType || file.mimetype,
      fileSize: upload.fileSize || file.size,
      fileUrl: signedUrl,
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
