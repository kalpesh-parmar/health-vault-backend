const providerType = Object.freeze({
  GOOGLE: "google",
  FACEBOOK: "facebook",
  APPLE: "apple",
  MICROSOFT: "microsoft",
  MOBILE: "mobile",
});
const providerValues = Object.values(providerType);
module.exports = { providerType, providerValues };
