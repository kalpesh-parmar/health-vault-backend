const LoginType = Object.freeze({
  MOBILE: "mobile",
  SOCIAL: "social",
});

const SocialMedia = Object.freeze({
  GOOGLE: "google",
  FACEBOOK: "facebook",
  MICROSOFT: "microsoft",
  APPLE: "apple",
});

const LoginTypeValues = Object.values(LoginType);

const SocialMediaProviders = Object.values(SocialMedia);

module.exports = { LoginType, SocialMedia, LoginTypeValues, SocialMediaProviders };
