const { env } = require("../configs/env");
const gcpStorageService = require("./gcpStorage.service");
const fileService = require("./file.service");
const { messageConstants } = require("../constants/messageConstants");

const providers = Object.freeze({
  gcp: gcpStorageService,
  s3: fileService,
});

class ObjectStorageService {
  constructor(providerName = env.storageProvider) {
    this.providerName = providerName;
    this.provider = providers[providerName];
    if (!this.provider) {
      throw new Error(messageConstants.UNSUPPORTED_STORAGE_PROVIDER_ERROR(providerName));
    }
  }

  async uploadFile(file, folder, patientId, options = {}) {
    return this.provider.uploadFile(file, folder, patientId, options);
  }

  async uploadBuffer({ body, contentType, key }) {
    return this.provider.uploadBuffer({ body, contentType, key });
  }

  async getSignedFileUrl(fileKey) {
    return this.provider.getSignedFileUrl(fileKey);
  }

  async getFileBuffer(fileKey) {
    return this.provider.getFileBuffer(fileKey);
  }

  async getFileStream(fileKey) {
    return this.provider.getFileStream(fileKey);
  }

  async deleteFile(fileKey) {
    return this.provider.deleteFile(fileKey);
  }

  getProviderName() {
    return this.providerName;
  }
}

module.exports = new ObjectStorageService();
module.exports.ObjectStorageService = ObjectStorageService;
