const languageType = Object.freeze({
  ENGLISH: "english",
  GUJARATI: "gujarati",
  HINDI: "hindi",
  MARATHI: "marathi",
  TAMIL: "tamil",
});

const languageTypeValues = Object.values(languageType);

// Helper for native display labels in the UI
const languageNativeLabels = {
  [languageType.ENGLISH]: "English",
  [languageType.GUJARATI]: "ગુજરાતી (Gujarati)",
  [languageType.HINDI]: "हिंदी (Hindi)",
  [languageType.MARATHI]: "मराठी (Marathi)",
  [languageType.TAMIL]: "தமிழ் (Tamil)",
};

module.exports = {
  languageType,
  languageTypeValues,
  languageNativeLabels,
};
