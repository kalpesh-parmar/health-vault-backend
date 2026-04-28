const { DeleteObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const { s3Buckets, s3Client } = require("../configs/s3");

class StorageService {
  getBuckets() {
    return s3Buckets;
  }

  async uploadPatientDocument({ body, contentType, key }) {
    await s3Client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: s3Buckets.patientDocuments,
        ContentType: contentType,
        Key: key,
      }),
    );

    return {
      bucket: s3Buckets.patientDocuments,
      key,
    };
  }

  async uploadProfileImage({ body, contentType, key }) {
    await s3Client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: s3Buckets.userProfileImages,
        ContentType: contentType,
        Key: key,
      }),
    );

    return {
      bucket: s3Buckets.userProfileImages,
      key,
    };
  }

  async deleteObject({ bucket, key }) {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    return {
      bucket,
      deleted: true,
      key,
    };
  }
}

module.exports = new StorageService();
