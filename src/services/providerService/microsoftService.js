const { verifyToken } = require("../../utils/microsoftUtils");
const { UnauthorizedException, InvalidRequestException } = require("../../exceptions/appError");
const { errorConstants } = require("../../constants/errorConstants");
const { env } = require("../../configs/env");

async function microsoftLogin(providerToken, userInfo) {
  try {
    if (!providerToken) {
      throw new InvalidRequestException(errorConstants.TOKEN_REQUIRED);
    }

    const microsoftUser = await verifyToken(providerToken);
    userInfo.providerUserId = microsoftUser.id;
    userInfo.email = microsoftUser.email;
    userInfo.firstName = microsoftUser.given_name || "User";
    userInfo.lastName = microsoftUser.family_name || "";
    if (microsoftUser.picture) {
      userInfo.avatarUrl = microsoftUser.picture;
    }
  } catch (err) {
    if (env.enableDummyAuth) {
      userInfo = {
        providerUserId: `dummy-microsoft-id-${providerToken || "mock"}`,
        email: "dummy-microsoft-user@example.com",
        firstName: "Dummy",
        lastName: "MicrosoftUser",
      };
    } else {
      console.error(err);
      throw new UnauthorizedException("Invalid Microsoft token");
    }
  }
  return userInfo;
}

module.exports = { microsoftLogin };
