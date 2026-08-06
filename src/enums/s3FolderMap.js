const S3Key_folder_map = Object.freeze({
  PATIENT_PROFILE: "PATIENT_PROFILE",
  PATIENT_DOCUMENT: "PATIENT_DOCUMENT",
});
const folderTypeValues = Object.values(S3Key_folder_map);
module.exports = { S3Key_folder_map, folderTypeValues };
