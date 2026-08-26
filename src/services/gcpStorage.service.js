const crypto = require("crypto");
const { env } = require("../configs/env");
const { gcpStorage } = require("../configs/gcpStorage");
const { messageConstants } = require("../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../exceptions/appError");

class GcpStorageService {
  constructor() {
    this.bucket = env.gcpStorageBucket;
  }

  async uploadFile(file, category, patientId, options = {}) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!category) {
      throw new InvalidRequestException("Category is required");
    }

    const opts = typeof patientId === "object" && patientId !== null ? patientId : options;
    const actualPatientId = typeof patientId === "string" ? patientId : opts.patientId;
    const pinnedKey = opts?.fileKey || opts?.key;

    let fileKey;
    if (pinnedKey) {
      fileKey = pinnedKey;
    } else {
      const uuid = crypto.randomUUID();
      const sanitizedName = file.originalname.replace(/\s+/g, "_");
      if (actualPatientId) {
        fileKey = `${category}/${actualPatientId}/${uuid}-${sanitizedName}`;
      } else {
        fileKey = `${category}/${uuid}-${sanitizedName}`;
      }
    }

    const bucket = gcpStorage.bucket(this.bucket);
    const blob = bucket.file(fileKey);
    await blob.save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
    });

    return {
      fileKey,
      fileType: file.mimetype,
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

  async getFileStream(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(
        messageConstants.FILE_KEY_REQUIRED || "fileKey is required",
      );
    }
    const file = gcpStorage.bucket(this.bucket).file(fileKey);
    const [exists] = await file.exists();
    if (!exists) {
      throw new NotFoundException(`File not found in storage: ${fileKey}`);
    }
    const [metadata] = await file.getMetadata();
    return {
      stream: file.createReadStream(),
      contentType: metadata.contentType,
      contentLength: Number(metadata.size),
    };
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
