const { env } = require("../configs/env");
const facebookClient = require("../clients/facebookClient");

class FacebookAuth {
  async verifyToken(userAccessToken) {
    // Step 1: Validate token with Facebook
    const data = await facebookClient.debugToken(
      userAccessToken,
      `${env.facebookAppId}|${env.facebookAppSecret}`,
    );

    if (!data?.data?.is_valid) {
      throw new Error("Invalid Facebook token");
    }

    if (data.data.app_id !== env.facebookAppId) {
      throw new Error("Token does not belong to this application");
    }

    // Step 2: Fetch user profile
    const user = await facebookClient.getMeProfile(userAccessToken);

    return user;
  }
}

module.exports = new FacebookAuth();
