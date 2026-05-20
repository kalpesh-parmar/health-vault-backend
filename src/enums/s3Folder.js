const folderType = Object.freeze({
  PATIENT_PROFILE: "profile_image",
  DOCUMENT_UPLOAD: "uploads",
});
const folderTypeValues = Object.values(folderType);
module.exports = { folderType, folderTypeValues };
