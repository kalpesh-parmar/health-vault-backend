const { env } = require("../configs/env");
const { gcpStorage } = require("../configs/gcpStorage");
const { messageConstants } = require("../constants/messageConstants");
const { InvalidRequestException } = require("../exceptions/appError");

class GcpStorageService {
  constructor() {
    this.bucket = env.gcpStorageBucket;
  }

  async uploadFile(file, folder) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!folder) {
      throw new InvalidRequestException("Folder is required");
    }

    const fileKey = `${folder}/${Date.now()}-${file.originalname}`;
    const bucket = gcpStorage.bucket(this.bucket);
    const blob = bucket.file(fileKey);
    await blob.save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
    });

    return {
      fileKey,
      fileType: file.mimetype,
      filePath: `gs://${this.bucket}/${fileKey}`,
      fileName: file.originalname,
      fileSize: file.size,
      s3Bucket: this.bucket,
      s3Key: fileKey,
      storageProvider: "gcp",
    };
  }

  async uploadBuffer({ body, contentType, key }) {
    const bucket = gcpStorage.bucket(this.bucket);
    const blob = bucket.file(key);
    await blob.save(body, {
      contentType,
      resumable: false,
    });
    return {
      bucket: this.bucket,
      key,
      provider: "gcp",
    };
  }

  async getSignedFileUrl(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }

    const options = {
      action: "read",
      expires: Date.now() + 15 * 60 * 1000,
      version: "v4",
    };
    const [signedUrl] = await gcpStorage.bucket(this.bucket).file(fileKey).getSignedUrl(options);
    return signedUrl;
  }

  async getFileBuffer(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    const [contents] = await gcpStorage.bucket(this.bucket).file(fileKey).download();
    return contents;
  }

  async deleteFile(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    await gcpStorage.bucket(this.bucket).file(fileKey).delete({ ignoreNotFound: true });
    return true;
  }
}

module.exports = new GcpStorageService();
