const { OAuth2Client } = require("google-auth-library");
const { env } = require("../configs/env");

const client = new OAuth2Client(env.googleClientId);

class googleAuth {
  async ticket(token) {
    await client.verifyIdToken({
      idToken: token,
      audience: env.googleClientId,
    });
    // return ticket;
  }
}
module.exports = googleAuth;
