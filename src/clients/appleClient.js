const { createHttpClient } = require("../configs/http.config");
const apiConfig = require("../configs/api.config");

class AppleClient {
  constructor() {
    this.client = createHttpClient({
      baseURL: apiConfig.apple.baseURL,
      timeout: apiConfig.apple.timeout,
    });
    this.endpoints = apiConfig.apple.endpoints;
  }

  async fetchPublicKeys() {
    const { data } = await this.client.get(this.endpoints.keys);
    return data;
  }
}

module.exports = new AppleClient();
