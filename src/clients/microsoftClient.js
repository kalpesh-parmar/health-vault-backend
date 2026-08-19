const { createHttpClient } = require("../configs/http.config");
const apiConfig = require("../configs/api.config");

class MicrosoftClient {
  constructor() {
    this.client = createHttpClient({
      baseURL: apiConfig.microsoft.baseURL,
      timeout: apiConfig.microsoft.timeout,
    });
    this.endpoints = apiConfig.microsoft.endpoints;
  }

  async fetchOpenIdConfig(tenant = "common") {
    const url =
      typeof this.endpoints.openIdConfig === "function"
        ? this.endpoints.openIdConfig(tenant)
        : `/${tenant}/v2.0/.well-known/openid-configuration`;
    const { data } = await this.client.get(url);
    return data;
  }

  async fetchJwks(jwksUri) {
    const { data } = await this.client.get(jwksUri);
    return data;
  }

  async fetchCommonPublicKeys() {
    const { data } = await this.client.get(this.endpoints.commonKeys);
    return data;
  }
}

module.exports = new MicrosoftClient();
