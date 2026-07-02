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

  let files = [];
  if (req.files) {
    if (Array.isArray(req.files)) {
      files = req.files;
    } else {
      files = [...(req.files.file || []), ...(req.files.files || [])];
    }
  } else if (req.file) {
    files = [req.file];
  }

  if (files.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: "File is required" });
  }

  const uploadType = req.body.uploadType;

  if (uploadType === "PATIENT_PROFILE") {
    if (files.length > 1) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: "PATIENT_PROFILE allows only one picture." });
    }
    if (!files[0].mimetype.startsWith("image/")) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: "PATIENT_PROFILE allows only picture formats." });
    }
  }

  const { NonMedicalDocumentException } = require("../exceptions/appError");
  try {
    const results = [];
    for (const file of files) {
      const result = await uploadFileService.uploadFile(file, req.body.uploadType, patientId);
      results.push(result);
    }

    if (req.body.uploadType === "PATIENT_DOCUMENT") {
      const allMedical = results.every((r) => r.isMedicalDocument);
      if (allMedical) {
        return res.status(StatusCodes.OK).json({
          isMedicalDocument: true,
          documentType: results.length === 1 ? results[0].documentType : "multiple",
          data: results.length === 1 ? results[0].data : results.map((r) => r.data),
        });
      }
    }

    if (results.length === 1) {
      return successResponse(res, results[0], messageConstants.FILE_UPLOADED);
    }

    return successResponse(res, results, messageConstants.FILE_UPLOADED);
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
