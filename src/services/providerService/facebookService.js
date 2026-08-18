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

    console.log(
      "[FACEBOOK AUTH LOG] Decoded Token Payload:",
      JSON.stringify(facebookUser, null, 2),
    );

    const nameParts = (facebookUser.name || "").trim().split(" ");

    userInfo.providerUserId = facebookUser.uid || facebookUser.user_id || facebookUser.sub;
    userInfo.email = facebookUser.email || null;
    userInfo.firstName = facebookUser.first_name || nameParts[0] || "User";
    userInfo.lastName = facebookUser.last_name || nameParts.slice(1).join(" ") || "";
    if (facebookUser.picture) {
      userInfo.avatarUrl = facebookUser.picture;
    }

    console.log("[FACEBOOK AUTH LOG] Extracted User Info:", JSON.stringify(userInfo, null, 2));
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
