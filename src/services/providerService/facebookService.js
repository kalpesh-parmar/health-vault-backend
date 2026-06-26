const { env } = require("../../configs/env");
const { verifyFirebaseToken } = require("../../configs/firebase");
const { errorConstants } = require("../../constants/errorConstants");
const { InvalidRequestException, UnauthorizedException } = require("../../exceptions/appError");

async function facebookLogin(firebaseIdToken, userInfo) {
  try {
    if (!firebaseIdToken) {
      throw new InvalidRequestException(errorConstants.TOKEN_REQUIRED);
    }

    const facebookUser = await verifyFirebaseToken(firebaseIdToken);
    userInfo.providerUserId = facebookUser.uid;
    userInfo.email = facebookUser.email;
    userInfo.firstName = facebookUser.first_name || "User";
    userInfo.lastName = facebookUser.last_name || "";
    if (facebookUser.picture) {
      userInfo.avatarUrl = facebookUser.picture;
    }
  } catch (err) {
    if (env.enableDummyAuth) {
      userInfo = {
        providerUserId: `dummy-facebook-id-${firebaseIdToken || "mock"}`,
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
