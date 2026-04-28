const fileType = Object.freeze({
  DOCX: "docx",
  JPEG: "jpeg",
  PDF: "pdf",
  PNG: "png",
  TXT: "txt",
});

const fileTypeValue = Object.values(fileType);

module.exports = {
  fileType,
  fileTypeValue,
};
