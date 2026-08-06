const fileType = Object.freeze({
  DOCX: "application/document",
  JPEG: "image/jpeg",
  PDF: "application/pdf",
  PNG: "image/png",
  TIFF: "image/tiff",
  TXT: "text/plain",
  WEBP: "image/webp",
  JPG: "image/jpg",
});

const fileTypeValue = Object.values(fileType);

module.exports = {
  fileType,
  fileTypeValue,
};
