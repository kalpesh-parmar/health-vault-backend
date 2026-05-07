const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { s3Client } = require("../configs/s3");

class S3Service {
  constructor() {
    this.bucket = process.env.PATIENT_DOCUMENTS_BUCKET;
  }

  async uploadFile(file) {
    const fileKey = `uploads/${Date.now()}-${file.originalname}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    await s3Client.send(command);

    return {
      fileKey,
      bucket: this.bucket,
      fileStoragePath: `https://${this.bucket}.s3.amazonaws.com/${fileKey}`,
    };
  }

  async generateSignedUrl(fileKey) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      ResponseContentDisposition: "inline",
    });

    return await getSignedUrl(s3Client, command, {
      expiresIn: 1800,
    });
  }
}

module.exports = new S3Service();
