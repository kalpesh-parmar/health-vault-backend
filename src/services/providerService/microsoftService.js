const { UnauthorizedException, InvalidRequestException } = require("../../exceptions/appError");
const { errorConstants } = require("../../constants/errorConstants");
const { env } = require("../../configs/env");
const { verifyFirebaseToken } = require("../../utils/firebaseUtils");

async function microsoftLogin(firebaseIdToken, userInfo) {
  try {
    if (!firebaseIdToken) {
      throw new InvalidRequestException(errorConstants.TOKEN_REQUIRED);
    }

    const microsoftUser = await verifyFirebaseToken(firebaseIdToken);
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
        providerUserId: `dummy-microsoft-id-${firebaseIdToken || "mock"}`,
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
