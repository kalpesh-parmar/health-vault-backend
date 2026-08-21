const crypto = require("crypto");
const { InvalidRequestException, NotFoundException } = require("../exceptions/appError");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client } = require("../configs/file");
const { env } = require("../configs/env");
const { messageConstants } = require("../constants/messageConstants");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

class S3Service {
  constructor() {
    this.bucket = env.patientDocumentsBucket;
    this.region = env.awsRegion;
    this.provider = "s3";
  }

  // Upload file method
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

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    await s3Client.send(command);
    return {
      fileKey,
      fileType: file.mimetype,
      fileName: file.originalname,
      fileSize: file.size,
      s3Bucket: this.bucket,
      s3Key: fileKey,
      storageProvider: this.provider,
    };
  }

  async uploadBuffer({ body, contentType, key }) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    });
    await s3Client.send(command);
    return {
      bucket: this.bucket,
      key,
      provider: this.provider,
    };
  }

  //  Generate Signed URL
  async getSignedFileUrl(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });
    const signedUrl = await getSignedUrl(s3Client, command);
    return signedUrl;
  }

  // Download raw object bytes (used by the local OCR primary path).
  async getFileBuffer(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });
    const response = await s3Client.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async getFileStream(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(
        messageConstants.FILE_KEY_REQUIRED || "fileKey is required",
      );
    }
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: fileKey,
      });
      const response = await s3Client.send(command);
      return {
        stream: response.Body,
        contentType: response.ContentType,
        contentLength: response.ContentLength,
      };
    } catch (error) {
      if (error.name === "NoSuchKey") {
        throw new NotFoundException(`File not found in storage: ${fileKey}`);
      }
      throw error;
    }
  }

  //delete File
  async deleteFile(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });

    await s3Client.send(command);

    return true;
  }
}

module.exports = new S3Service();
