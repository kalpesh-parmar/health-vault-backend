const { StatusCodes } = require("http-status-codes");
const { ocrService, onboardingService } = require("../services/ai");
const { NonMedicalDocumentException } = require("../exceptions/appError");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const patientRepository = require("../repositories/patientRepository");

async function ocrExtract(req, res, next) {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  console.log(
    `[v1Controller] [${requestId}] Entry - ocrExtract start. User ID: ${req.auth?.userId}`,
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

    const {
      document: documentRow,
      ocrResult,
      structuredData,
    } = await ocrService.processAndStoreSynchronously({ file: req.file, userId });

    const duration = Date.now() - startTime;
    console.log(`[v1Controller] [${requestId}] Exit - ocrExtract success. Duration: ${duration}ms`);

    return res.status(StatusCodes.OK).json({
      status: "SUCCESS",
      message: "Document processed and stored successfully",
      data: {
        document: {
          id: documentRow.id,
          fileName: documentRow.fileName,
          filePath: documentRow.filePath,
          fileType: documentRow.fileType,
          fileSize: documentRow.fileSize,
          reportDate: documentRow.reportDate,
          hospitalName: documentRow.hospitalName,
          doctorName: documentRow.doctorName,
          remarks: documentRow.remarks,
          summaryGujarati: documentRow.summaryGujarati,
          ocrStatus: documentRow.ocrStatus,
          ocrExtractedText: documentRow.ocrExtractedText,
        },
        ocr: {
          detectedLanguages: ocrResult.detectedLanguages,
          pageCount: ocrResult.pageCount,
        },
        structuredData,
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[v1Controller] [${requestId}] OCR Extract failed after ${duration}ms:`, error);
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

    const { message, history = [], state } = req.body;
    if (message === undefined || !state) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: "message and state are required" });
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

module.exports = {
  ocrExtract,
  onboardingChat,
  getOnboardingStatus,
};
