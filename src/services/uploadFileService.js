const { messageConstants } = require("../constants/messageConstants");
const { folderType } = require("../enums/s3Folder");
const { InvalidRequestException } = require("../exceptions/appError");
const s3service = require("./s3service");

class uploadFileService {
  async uploadFile(file, uploadType) {
    console.log("uploadType", uploadType);

    const folder = folderType[uploadType];
    console.log("folder==", folder);

    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!folder) {
      throw new InvalidRequestException(messageConstants.INVALID_UPLOAD_TYPE);
    }
    const upload = await s3service.uploadFile(file, folder);
    return { upload };
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
