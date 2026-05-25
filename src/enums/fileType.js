const fileType = Object.freeze({
  DOCX: "application/document",
  JPEG: "image/jpeg",
  PDF: "application/pdf",
  PNG: "image/png",
  TXT: "text/plain",
  JPG: "image/jpg",
});

const fileTypeValue = Object.values(fileType);

module.exports = {
  fileType,
  fileTypeValue,
};
