const providerType = Object.freeze({
  GOOGLE: "google",
  FACEBOOK: "facebook",
  APPLE: "apple",
  EMAIL: "email",
  MOBILE: "mobile",
  MICROSOFT: "microsoft",
});
const providerValues = Object.values(providerType);
module.exports = { providerType, providerValues };
