const { S3Client } = require("@aws-sdk/client-s3");

const { env } = require("./env");

const s3Client = new S3Client({
  credentials:
    env.awsAccessKeyId && env.awsSecretAccessKey
      ? {
          accessKeyId: env.awsAccessKeyId,
          secretAccessKey: env.awsSecretAccessKey,
        }
      : undefined,
  region: env.awsRegion,
});

const s3Buckets = Object.freeze({
  patientDocuments: env.patientDocumentsBucket,
  userProfileImages: env.userProfileImagesBucket,
});

module.exports = {
  s3Buckets,
  s3Client,
};
