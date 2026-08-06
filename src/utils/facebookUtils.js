const axios = require("axios");
const { env } = require("../configs/env");

class FacebookAuth {
  async verifyToken(userAccessToken) {
    // Step 1: Validate token with Facebook
    const { data } = await axios.get("https://graph.facebook.com/debug_token", {
      params: {
        input_token: userAccessToken,
        access_token: `${env.facebookAppId}|${env.facebookAppSecret}`,
      },
    });

    if (!data?.data?.is_valid) {
      throw new Error("Invalid Facebook token");
    }

    if (data.data.app_id !== env.facebookAppId) {
      throw new Error("Token does not belong to this application");
    }

    // Step 2: Fetch user profile
    const { data: user } = await axios.get("https://graph.facebook.com/me", {
      params: {
        fields: "id,email,first_name,last_name,name",
        access_token: userAccessToken,
      },
    });

    return user;
  }
}

module.exports = new FacebookAuth();
