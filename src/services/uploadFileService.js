const { messageConstants } = require("../constants/messageConstants");
const { S3Key_folder_map } = require("../enums/uploadType");
const { InvalidRequestException } = require("../exceptions/appError");
const s3service = require("./s3service");

class uploadFileService {
  async uploadFile(file, uploadType) {
    const folder = S3Key_folder_map[uploadType];
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!folder) {
      throw new InvalidRequestException(messageConstants.INVALID_UPLOAD_TYPE);
    }
    const fileKey = `${folder}/${Date.now()}-${file.originalname}`;

    await s3service.uploadFile(file, fileKey);

    return { fileKey };
  }

  async deleteFile(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILEKEY_REQUIRED);
    }
    await s3service.deleteFile(fileKey);

    return { message: messageConstants.FILE_DELETED };
  }

  async getSignedUrl(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILEKEY_REQUIRED);
    }
    const signedUrl = await s3service.getSignedFileUrl(fileKey);
    return {
      signedUrl,
    };
  }
}
module.exports = new uploadFileService();
