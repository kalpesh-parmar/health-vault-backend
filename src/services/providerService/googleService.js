const { env } = require("../../configs/env");
const { errorConstants } = require("../../constants/errorConstants");
const { InvalidRequestException, UnauthorizedException } = require("../../exceptions/appError");
const googleAuth = require("../../utils/googleUtils");

async function googleLogin(token, userInfo) {
  try {
    if (!token) {
      throw new InvalidRequestException(errorConstants.TOKEN_REQUIRED);
    }
    const ticket = googleAuth.ticket(token);
    const googleUser = ticket.getPayload();
    userInfo.providerUserId = googleUser.sub;
    userInfo.email = googleUser.email;
    userInfo.firstName = googleUser.given_name || "User";
    userInfo.lastName = googleUser.family_name || "";
  } catch (err) {
    if (env.enableDummyAuth) {
      userInfo = {
        providerUserId: `dummy-google-id-${token || "mock"}`,
        email: "dummy-google-user@example.com",
        firstName: "Dummy",
        lastName: "GoogleUser",
      };
    } else {
      console.error(err);
      throw new UnauthorizedException("Invalid Google token");
    }
  }
  return userInfo;
}

module.exports = { googleLogin };
