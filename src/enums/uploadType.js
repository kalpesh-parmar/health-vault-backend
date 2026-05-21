const S3Key_folder_map = Object.freeze({
  PATIENT_PROFILE: "PATIENT_PROFILE",
  PATIENT_DOCUMENT: "DOCUMENT_UPLOAD",
});

const uploadTypeValues = Object.values(S3Key_folder_map);

module.exports = { S3Key_folder_map, uploadTypeValues };
