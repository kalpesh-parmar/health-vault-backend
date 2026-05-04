const { InvalidRequestException } = require("../exceptions/appError");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client } = require("../configs/s3");
const documentService = require("./documentService");
const { messageConstants } = require("../constants/messageConstants");

class S3Service {
  constructor() {
    this.bucket = process.env.AWS_BUCKET;
    this.region = process.env.AWS_REGION;
    this.folder = "patient_Document";
  }

  // Upload file method
  async uploadFile(file) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    const fileKey = `${this.folder}/${Date.now()}-${file.originalname}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    });
    await s3Client.send(command);
    await documentService.createDocument(command);
    return {
      fileKey,
    };
  }
}

module.exports = new S3Service();
