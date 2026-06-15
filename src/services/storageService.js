const { env } = require("../configs/env");
const objectStorageService = require("./objectStorageService");

class StorageService {
  getBuckets() {
    const bucket = env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName;
    return {
      patientDocuments: bucket,
      userProfileImages: bucket,
      provider: env.storageProvider,
    };
  }

  async uploadPatientDocument({ body, contentType, key }) {
    const uploaded = await objectStorageService.uploadBuffer({ body, contentType, key });
    return {
      bucket: uploaded.bucket,
      key: uploaded.key,
      provider: uploaded.provider,
    };
  }

  async uploadProfileImage({ body, contentType, key }) {
    const uploaded = await objectStorageService.uploadBuffer({ body, contentType, key });
    return {
      bucket: uploaded.bucket,
      key: uploaded.key,
      provider: uploaded.provider,
    };
  }

  async deleteObject({ key }) {
    await objectStorageService.deleteFile(key);
    return {
      deleted: true,
      key,
      provider: objectStorageService.getProviderName(),
    };
  }
}

module.exports = new StorageService();
