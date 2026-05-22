const folderType = Object.freeze({
  PATIENT_PROFILE: "profile_image",
  PATIENT_DOCUMENT: "uploads",
});
const folderTypeValues = Object.values(folderType);
module.exports = { folderType, folderTypeValues };
