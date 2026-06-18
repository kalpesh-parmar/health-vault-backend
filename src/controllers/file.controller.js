const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const { InvalidRequestException } = require("../exceptions/appError");
const uploadFileService = require("../services/fileservice");

async function uploadFile(req, res) {
  let patientId = req.body.patientId || req.auth?.userId;
  if (!patientId) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const jwt = require("jsonwebtoken");
        const { env } = require("../configs/env");
        const decoded = jwt.verify(token, env.jwtSecret);
        patientId = decoded.userId;
      } catch {
        // Ignore JWT verification errors for anonymous uploads
      }
    }
  }

  const { NonMedicalDocumentException } = require("../exceptions/appError");
  try {
    const result = await uploadFileService.uploadFile(req.file, req.body.uploadType, patientId);

    if (req.body.uploadType === "PATIENT_DOCUMENT" && result.isMedicalDocument !== undefined) {
      return res.status(StatusCodes.OK).json({
        isMedicalDocument: true,
        documentType: result.documentType,
        data: result.data,
      });
    }

    return successResponse(res, result, messageConstants.FILE_UPLOADED);
  } catch (error) {
    if (error instanceof NonMedicalDocumentException) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        data: null,
        status: {
          status: "FAILED",
          statusCode: StatusCodes.BAD_REQUEST,
          description: "The uploaded file is not a medical document.",
        },
        error: {
          code: "INVALID_MEDICAL_DOCUMENT",
          message:
            "Please upload a valid medical report such as a lab report, prescription, X-ray, MRI, or discharge summary.",
        },
      });
    }
    throw error;
  }
}

async function viewFile(req, res) {
  const { fileKey } = req.query;
  if (!fileKey) {
    throw new InvalidRequestException(messageConstants.FILEKEY_REQUIRED || "fileKey is required");
  }

  const { stream, contentType, contentLength } = await uploadFileService.getFileStream(fileKey);

  const filename = fileKey.split("/").pop() || "file";

  res.setHeader("Content-Type", contentType || "application/octet-stream");
  if (contentLength) {
    res.setHeader("Content-Length", contentLength);
  }

  const cleanMime = (contentType || "").toLowerCase();
  const inlineMimes = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "application/pdf",
  ];

  if (inlineMimes.includes(cleanMime)) {
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  } else {
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  }

  stream.on("error", (err) => {
    console.error("Stream error for fileKey:", fileKey, err);
    if (!res.headersSent) {
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).send("Stream error");
    }
  });

  stream.pipe(res);
}

async function deleteFile(req, res) {
  const result = await uploadFileService.deleteFile(req.query);
  return successResponse(res, result, messageConstants.FILE_DELETED);
}

module.exports = {
  uploadFile,
  viewFile,
  deleteFile,
};
