const jwt = require("jsonwebtoken");
const { StatusCodes } = require("http-status-codes");
const { env } = require("../configs/env");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const {
  InvalidRequestException,
  NonMedicalDocumentException,
  NotFoundException,
  UnauthorizedException,
} = require("../exceptions/appError");
const patientRepository = require("../repositories/patientRepository");
const uploadFileService = require("../services/file.service");
const documentRepository = require("../repositories/documentRepository");
const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");

async function uploadFile(req, res) {
  let patientId = req.body.patientId || req.auth?.userId;
  if (!patientId) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
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

  if (uploadType === "PATIENT_DOCUMENT" && patientId) {
    const patient = await patientRepository.findById(patientId);

    if (patient) {
      // 1. Onboarding flow constraints
      if (!patient.onboardingCompleted) {
        if (files.length > 1) {
          return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ error: "Onboarding flow allows only one document." });
        }
      } else {
        // 2. Dashboard flow constraints
        if (files.length > 5) {
          return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ error: "Dashboard allows a maximum of 5 documents at a time." });
        }
      }
    }

    const validMimes = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"];
    for (const f of files) {
      if (!validMimes.includes(f.mimetype.toLowerCase())) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: `Invalid file format for ${f.originalname}. Allowed formats are images and PDF.`,
        });
      }
    }
  }

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function viewFile(req, res) {
  const userId = req.auth?.userId;
  if (!userId) {
    throw new UnauthorizedException("Unauthorized");
  }

  const { fileKey: rawFileKey, documentId: rawDocumentId } = req.query;
  const inputKey = (rawFileKey || "").trim();
  const inputDocId = (rawDocumentId || "").trim();

  if (!inputKey && !inputDocId) {
    throw new InvalidRequestException(
      messageConstants.FILEKEY_REQUIRED || "fileKey or documentId is required",
    );
  }

  // Reject invalid object serialization
  if (inputKey === "[object Object]") {
    throw new InvalidRequestException("Invalid fileKey parameter");
  }

  let resolvedFileKey = null;

  // 1. If explicit documentId is provided or inputKey is a UUID: check documents table
  const candidateDocId = inputDocId || (UUID_REGEX.test(inputKey) ? inputKey : null);
  if (candidateDocId) {
    const doc = await documentRepository.findActiveDocumentById(candidateDocId, userId);
    if (doc && doc.s3Key) {
      resolvedFileKey = doc.s3Key;
    }
  }

  // 2. If not resolved yet and inputKey was provided
  if (!resolvedFileKey && inputKey) {
    // Check if inputKey matches a document by s3Key owned by this user
    const docByKey = await documentRepository.findByFileKey(inputKey, userId);
    if (docByKey && docByKey.s3Key) {
      resolvedFileKey = docByKey.s3Key;
    } else {
      // Check if inputKey matches an active/temporary processing job owned by this user (pre-onboarding upload)
      const jobByKey = await documentProcessingJobRepository.findByFileKey(inputKey, userId);
      if (jobByKey && jobByKey.fileKey) {
        resolvedFileKey = jobByKey.fileKey;
      } else if (
        inputKey.startsWith(`PATIENT_DOCUMENT/${userId}/`) ||
        inputKey.startsWith(`PATIENT_PROFILE/${userId}/`)
      ) {
        // Explicitly namespaced under the authenticated user's S3 folder
        resolvedFileKey = inputKey;
      }
    }
  }

  if (!resolvedFileKey) {
    throw new NotFoundException("Document not found or unauthorized");
  }

  const { stream, contentType, contentLength } =
    await uploadFileService.getFileStream(resolvedFileKey);

  const filename = resolvedFileKey.split("/").pop() || "file";

  res.setHeader("Content-Type", contentType || "application/octet-stream");
  if (contentLength) {
    res.setHeader("Content-Length", contentLength);
  }

  // Security & browser caching headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=3600");

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
    console.error("Stream error for fileKey:", resolvedFileKey, err);
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
