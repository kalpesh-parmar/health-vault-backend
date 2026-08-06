const { OAuth2Client } = require("google-auth-library");
const { env } = require("../configs/env");

const client = new OAuth2Client(env.googleClientId);

class googleAuth {
  async ticket(token) {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: env.googleWebClientId,
    });
    return ticket;
  }
}
module.exports = new googleAuth();
