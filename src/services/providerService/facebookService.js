const { env } = require("../../configs/env");
const { errorConstants } = require("../../constants/errorConstants");
const { InvalidRequestException, UnauthorizedException } = require("../../exceptions/appError");
const facebookAuth = require("../../utils/facebookUtils");

async function facebookLogin(token, userInfo) {
  try {
    if (!token) {
      throw new InvalidRequestException(errorConstants.TOKEN_REQUIRED);
    }

    const facebookUser = await facebookAuth.verifyToken(token);

    userInfo.providerUserId = facebookUser.id;
    userInfo.email = facebookUser.email;
    userInfo.firstName = facebookUser.first_name || "User";
    userInfo.lastName = facebookUser.last_name || "";
  } catch (err) {
    if (env.enableDummyAuth) {
      userInfo = {
        providerUserId: `dummy-facebook-id-${token || "mock"}`,
        email: "dummy-facebook-user@example.com",
        firstName: "Dummy",
        lastName: "FacebookUser",
      };
    } else {
      console.error(err);
      throw new UnauthorizedException("Invalid Facebook token");
    }
  }
  return userInfo;
}

module.exports = { facebookLogin };
