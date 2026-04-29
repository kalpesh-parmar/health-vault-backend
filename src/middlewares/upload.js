const multer = require("multer");
const { messageConstants } = require("../constants/messageConstants");
const { InvalidRequestException, InternalServerException } = require("../exceptions/appError");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});
const validateFile = (req, res, next) => {
  try {
    if (!req.file) {
      return InvalidRequestException(res, messageConstants.FILE_REQUIRED);
    }

    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ];

    if (!allowedTypes.includes(req.file.mimetype)) {
      return InvalidRequestException(res, messageConstants.INVALID_FILE_TYPE);
    }

    next();
  } catch (error) {
    console.error("File validation error:", error);

    return InternalServerException(res, messageConstants.SERVER_ERROR);
  }
  return null;
};

module.exports = {
  upload,
  validateFile,
};
