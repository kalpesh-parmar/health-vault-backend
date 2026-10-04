const fileType = Object.freeze({
  DOCX: {
    ext: "docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  DOC: { ext: "doc", type: "application/msword" },
  JPEG: { ext: "jpeg", type: "image/jpeg" },
  PDF: { ext: "pdf", type: "application/pdf" },
  PNG: { ext: "png", type: "image/png" },
  TIF: { ext: "tif", type: "image/tiff" },
  TIFF: { ext: "tiff", type: "image/tiff" },
  TXT: { ext: "txt", type: "text/plain" },
  WEBP: { ext: "webp", type: "image/webp" },
  JPG: { ext: "jpg", type: "image/jpg" },
});

const fileTypeValue = Object.values(fileType).map((item) => item.type);
const fileExtensionValue = Object.values(fileType).map((item) => item.ext);

module.exports = {
  fileType,
  fileTypeValue,
  fileExtensionValue,
};
