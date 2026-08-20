const { createHttpClient } = require("../configs/http.config");
const apiConfig = require("../configs/api.config");

class FacebookClient {
  constructor() {
    this.client = createHttpClient({
      baseURL: apiConfig.facebook.baseURL,
      timeout: apiConfig.facebook.timeout,
    });
    this.endpoints = apiConfig.facebook.endpoints;
  }

  async debugToken(inputToken, accessToken) {
    const { data } = await this.client.get(this.endpoints.debugToken, {
      params: {
        input_token: inputToken,
        access_token: accessToken,
      },
    });
    return data;
  }

  async getMeProfile(userAccessToken, fields = "id,email,first_name,last_name,name") {
    const { data } = await this.client.get(this.endpoints.me, {
      params: {
        fields,
        access_token: userAccessToken,
      },
    });
    return data;
  }
}

module.exports = new FacebookClient();
