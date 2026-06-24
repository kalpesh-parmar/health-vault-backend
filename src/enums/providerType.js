const providerType = Object.freeze({
  GOOGLE: "google",
  FACEBOOK: "facebook",
  APPLE: "apple",
  MICROSOFT: "microsoft",
});
const providerValues = Object.values(providerType);
module.exports = { providerType, providerValues };
