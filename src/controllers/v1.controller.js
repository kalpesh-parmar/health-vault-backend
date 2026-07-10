const { StatusCodes } = require("http-status-codes");
const { ocrService, onboardingService } = require("../services/ai");
const { NonMedicalDocumentException } = require("../exceptions/appError");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const patientRepository = require("../repositories/patientRepository");
const { fileTypeValue } = require("../enums/fileType");

function inferFileType(mimeType) {
  if (!mimeType) return null;

  const lower = mimeType.toLowerCase().trim();

  const supportedTypes = new Set(fileTypeValue.map((type) => type.toLowerCase()));

  return supportedTypes.has(lower) ? lower : null;
}
async function ocrExtract(req, res, next) {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  console.log(
    `[v1Controller] [${requestId}] Entry - async ocrExtract start. User ID: ${req.auth?.userId}`,
  );

  try {
    const userId = req.auth?.userId;
    if (!userId) {
      console.warn(`[v1Controller] [${requestId}] Exit - Unauthorized access attempt`);
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: "Unauthorized access" });
    }

    if (!req.file) {
      console.warn(`[v1Controller] [${requestId}] Exit - No file uploaded`);
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "No file uploaded" });
    }

    console.log(
      `[v1Controller] [${requestId}] File Info: OriginalName=${req.file.originalname}, Size=${req.file.size} bytes, MimeType=${req.file.mimetype}`,
    );

    // 1. Upload and validate synchronously (fast, throws on non-medical document)
    const uploadFileService = require("../services/uploadFileService");
    const uploadResult = await uploadFileService.uploadFile(req.file, "PATIENT_DOCUMENT", userId);

    // 2. Create the document row with status = "in_progress" (maps to "processing")
    const { db } = require("../configs/db");
    const { document } = require("../models/document");
    const { ocrStatus } = require("../enums/ocrStatus");
    const { env } = require("../configs/env");

    const fileKey = uploadResult.data.fileKey;
    const bucketName =
      uploadResult.data.s3Bucket ||
      (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName);
    const filePath =
      env.storageProvider === "gcp"
        ? `gs://${bucketName}/${fileKey}`
        : `https://${bucketName}.s3.amazonaws.com/${fileKey}`;

    const [documentRow] = await db
      .insert(document)
      .values({
        userId,
        documentType: "medical_document",
        fileName: uploadResult.data.originalFileName,
        filePath,
        s3Bucket: bucketName,
        s3Key: fileKey,
        fileType: inferFileType(uploadResult.data.mimeType),
        fileSize: uploadResult.data.fileSize,
        ocrStatus: ocrStatus.IN_PROGRESS,
      })
      .returning();

    // 3. Fire-and-forget background pipeline
    setImmediate(() => {
      ocrService
        .processAndStoreAsynchronously({
          documentId: documentRow.id,
          file: req.file,
          userId,
          uploadResult,
        })
        .catch((err) => {
          console.error(
            `[v1Controller] [${requestId}] Background pipeline error for doc ${documentRow.id}:`,
            err,
          );
        });
    });

    const duration = Date.now() - startTime;
    console.log(
      `[v1Controller] [${requestId}] Exit - async ocrExtract start success. Duration: ${duration}ms`,
    );

    return res.status(StatusCodes.ACCEPTED).json({
      status: "SUCCESS",
      message: "Document processing started",
      data: {
        document: {
          id: documentRow.id,
          fileName: documentRow.fileName,
          filePath: documentRow.filePath,
          fileType: documentRow.fileType,
          fileSize: documentRow.fileSize,
          ocrStatus: documentRow.ocrStatus,
        },
        documentId: documentRow.id,
        status: "processing",
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(
      `[v1Controller] [${requestId}] OCR Extract initiation failed after ${duration}ms:`,
      error,
    );
    if (error.stack) {
      console.error(`[v1Controller] [${requestId}] Error stack trace:`, error.stack);
    }

    if (
      error instanceof NonMedicalDocumentException ||
      error.name === "NonMedicalDocumentException"
    ) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        status: "FAILED",
        error: {
          code: "INVALID_MEDICAL_DOCUMENT",
          message: error.message || "The uploaded file is not a medical document.",
          classification: error.classification || null,
        },
      });
    }
    return next(error);
  }
}

async function getOcrStatus(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: "Unauthorized access" });
    }

    const { documentId } = req.params;
    if (!documentId) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "documentId is required" });
    }

    const documentRepository = require("../repositories/documentRepository");
    const docRow = await documentRepository.findById(documentId);

    if (!docRow || String(docRow.userId) !== String(userId)) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Document not found" });
    }

    let status = "processing";
    if (docRow.ocrStatus === "completed") {
      status = "done";
    } else if (docRow.ocrStatus === "failed") {
      status = "failed";
    }

    return res.status(StatusCodes.OK).json({
      status: "SUCCESS",
      data: {
        documentId: docRow.id,
        status,
        summary: docRow.summaryInPreferredLanguage || docRow.summaryEnglish || "",
        document: {
          id: docRow.id,
          fileName: docRow.fileName,
          filePath: docRow.filePath,
          fileType: docRow.fileType,
          fileSize: docRow.fileSize,
          ocrStatus: docRow.ocrStatus,
          ocrExtractedText: docRow.ocrExtractedText,
        },
        structuredData: docRow.structuredExtractedData || {},
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function onboardingChat(req, res, next) {
  const requestReceivedTime = Date.now();
  console.log(
    `[OnboardingController] Request received at ${new Date(requestReceivedTime).toISOString()}`,
  );

  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: "Unauthorized access" });
    }

    let { message, history = [], state } = req.body;
    if (message === undefined) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "message is required" });
    }

    // If frontend doesn't send state, fetch it from the database
    if (!state) {
      const existingRecord = await userOnboardingRepository.findByUserId(userId);
      if (existingRecord && existingRecord.data) {
        state = existingRecord.data;
        console.log(`[OnboardingController] [userId=${userId}] Restored state from database.`);
      } else {
        state = {}; // First time user
      }
    }

    console.log(
      `[OnboardingController] [userId=${userId}] Before Ollama API call at ${new Date().toISOString()}`,
    );

    const beforeOllamaTime = Date.now();
    const result = await onboardingService.chat(message, history, state, userId);
    const ollamaResponseTime = Date.now();

    console.log(
      `[OnboardingController] [userId=${userId}] Ollama response received at ${new Date(ollamaResponseTime).toISOString()}`,
    );
    console.log(
      `[OnboardingController] [userId=${userId}] Ollama latency: ${ollamaResponseTime - beforeOllamaTime}ms`,
    );

    const totalTime = Date.now() - requestReceivedTime;
    console.log(`[OnboardingController] [userId=${userId}] Total execution time: ${totalTime}ms`);

    return res.status(StatusCodes.OK).json({
      status: "SUCCESS",
      data: result,
    });
  } catch (error) {
    const errorTime = Date.now();
    const totalTime = errorTime - requestReceivedTime;
    console.error(`[OnboardingController] Onboarding chat failed after ${totalTime}ms:`);
    console.error(`Error Code: ${error.code || "N/A"}`);
    console.error(`Error Message: ${error.message}`);
    console.error(`Error Stack: ${error.stack}`);
    return next(error);
  }
}

async function getOnboardingStatus(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: "Unauthorized access" });
    }

    const patient = await patientRepository.findById(userId);
    if (!patient) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: "Patient not found" });
    }

    const isOnboardingCompleted = !!(
      patient.firstName &&
      patient.firstName !== "User" &&
      patient.lastName &&
      patient.gender &&
      patient.dateOfBirth
    );

    // If onboarding is already completed, return completed status
    if (isOnboardingCompleted) {
      return res.status(StatusCodes.OK).json({
        status: "SUCCESS",
        data: {
          isOnboardingCompleted: true,
          currentStep: "COMPLETE",
          resumableState: null,
        },
      });
    }

    // Get saved onboarding state for resumption
    const onboardingRecord = await userOnboardingRepository.findByUserId(userId);

    const currentStep = onboardingRecord?.data?.currentStep || "ASK_LANGUAGE";
    const resumableState = onboardingRecord?.data || null;

    return res.status(StatusCodes.OK).json({
      status: "SUCCESS",
      data: {
        isOnboardingCompleted: false,
        currentStep,
        resumableState,
      },
    });
  } catch (error) {
    console.error("[OnboardingController] getOnboardingStatus failed:", error);
    return next(error);
  }
}

async function cancelOcr(req, res, next) {
  try {
    const userId = req.auth?.userId;
    const { documentId } = req.params;
    if (!userId || !documentId) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "Missing parameters" });
    }

    const { db } = require("../configs/db");
    const { document } = require("../models/document");
    const { ocrStatus } = require("../enums/ocrStatus");
    const { eq, and } = require("drizzle-orm");

    await db
      .update(document)
      .set({
        ocrStatus: ocrStatus.CANCELLED,
        remarks: "ERR_CODE:USER_CANCELLED",
        updatedAt: new Date(),
      })
      .where(and(eq(document.id, documentId), eq(document.userId, userId)));

    return res
      .status(StatusCodes.OK)
      .json({ status: "SUCCESS", message: "Job cancelled successfully" });
  } catch (error) {
    console.error("[OnboardingController] cancelOcr failed:", error);
    return next(error);
  }
}

module.exports = {
  ocrExtract,
  getOcrStatus,
  cancelOcr,
  onboardingChat,
  getOnboardingStatus,
};
