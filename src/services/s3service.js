const { InvalidRequestException } = require("../exceptions/appError");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client } = require("../configs/s3");
// const documentService = require("./documentService");
const { messageConstants } = require("../constants/messageConstants");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

class S3Service {
  constructor() {
    this.bucket = process.env.PATIENT_DOCUMENTS_BUCKET;
    this.region = process.env.AWS_REGION;
  }

  // Upload file method
  async uploadFile(file, folder) {
    if (!file) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED);
    }
    if (!folder) {
      throw new InvalidRequestException("Folder is required");
    }
    const fileKey = `${folder}/${Date.now()}-${file.originalname}`;
    const filePath = `https://${this.bucket}.s3.amazonaws.com/${fileKey}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    await s3Client.send(command);
    // await documentService.createDocument(command);
    return {
      fileKey,
      fileType: file.mimetype,
      filePath,
      fileName: file.originalname,
      fileSize: file.size,
      s3Bucket: this.bucket,
      s3Key: fileKey,
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
