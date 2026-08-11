const { eq, and } = require("drizzle-orm");

const { env } = require("../configs/env");
const { db } = require("../configs/db");
// const { fileTypeValue } = require("../enums/fileType");
const { ocrStatus } = require("../enums/ocrStatus");
const {
  InvalidRequestException,
  NotFoundException,
  UnauthorizedException,
} = require("../exceptions/appError");
const { document } = require("../models/document");
const chatSessionRepository = require("../repositories/chatSessionRepository");
const documentRepository = require("../repositories/documentRepository");
const patientRepository = require("../repositories/patientRepository");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const { onboardingService } = require("./ai");
const { ocrService } = require("./ai/ocr/ocr.service");
const uploadFileService = require("./uploadFile.service");
const { normalizeLanguage } = require("../utils/commonUtils");
const { messageConstants } = require("../constants/messageConstants");
const { inferFileType } = require("../helpers/document.helper");

class V1Service {
  async ocrExtract(userId, file) {
    const startTime = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    console.log(`[v1Controller] [${requestId}] Entry - async ocrExtract start. User ID: ${userId}`);

    try {
      if (!userId) {
        console.warn(`[v1Controller] [${requestId}] Exit - Unauthorized access attempt`);
        throw new UnauthorizedException(messageConstants.UNAUTHORIZED_ACCESS);
      }

      if (!file) {
        console.warn(`[v1Controller] [${requestId}] Exit - No file uploaded`);
        throw new InvalidRequestException(messageConstants.NO_FILE_UPLOAD);
      }

      console.log(
        `[v1Controller] [${requestId}] File Info: OriginalName=${file.originalname}, Size=${file.size} bytes, MimeType=${file.mimetype}`,
      );

      // 1. Upload and validate synchronously (fast, throws on non-medical document)
      const uploadResult = await uploadFileService.uploadFile(file, "PATIENT_DOCUMENT", userId);

      // 2. Create the document row with status = "in_progress" (maps to "processing")
      const fileKey = uploadResult.data.fileKey;
      const bucketName =
        uploadResult.data.s3Bucket ||
        (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName);

      const [documentRow] = await db
        .insert(document)
        .values({
          userId,
          documentType: "medical_document",
          fileName: uploadResult.data.originalFileName,
          //optional fileName from given by user
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
            file: file,
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

      return {
        document: {
          id: documentRow.id,
          fileName: documentRow.fileName,
          fileType: documentRow.fileType,
          fileSize: documentRow.fileSize,
          ocrStatus: documentRow.ocrStatus,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(
        `[v1Controller] [${requestId}] OCR Extract initiation failed after ${duration}ms:`,
        error,
      );
      if (error.stack) {
        console.error(`[v1Controller] [${requestId}] Error stack trace:`, error.stack);
      }
      throw error;
    }
  }

  async getOcrStatus(userId, documentId) {
    if (!userId) {
      throw new UnauthorizedException("Unauthorized access");
    }

    if (!documentId) {
      throw new InvalidRequestException("documentId is required");
    }

    const docRow = await documentRepository.findById(documentId);

    if (!docRow || String(docRow.userId) !== String(userId)) {
      throw new NotFoundException("Document not found");
    }

    let status = "processing";
    if (docRow.ocrStatus === "completed") {
      status = "done";
    } else if (docRow.ocrStatus === "failed") {
      status = "failed";
    }

    return {
      documentId: docRow.id,
      status,
      summary: docRow.summaryInPreferredLanguage || docRow.summaryEnglish || "",
      document: {
        id: docRow.id,
        fileName: docRow.fileName,
        fileType: docRow.fileType,
        fileSize: docRow.fileSize,
        ocrStatus: docRow.ocrStatus,
        ocrExtractedText: docRow.ocrExtractedText,
      },
      structuredData: docRow.structuredExtractedData || {},
    };
  }

  async cancelOcr(userId, documentId) {
    if (!userId || !documentId) {
      throw new InvalidRequestException("Missing parameters");
    }

    await db
      .update(document)
      .set({
        ocrStatus: ocrStatus.CANCELED,
        remarks: "ERR_CODE:USER_CANCELLED",
        updatedAt: new Date(),
      })
      .where(and(eq(document.id, documentId), eq(document.userId, userId)));

    return { message: "Job cancelled successfully" };
  }

  async onboardingChat(userId, body) {
    const requestReceivedTime = Date.now();
    console.log(
      `[OnboardingController] Request received at ${new Date(requestReceivedTime).toISOString()}`,
    );

    try {
      if (!userId) {
        throw new UnauthorizedException("Unauthorized access");
      }

      let { message, history = [], state, displayLabel } = body || {};
      if (message === undefined) {
        throw new InvalidRequestException("message is required");
      }

      // Always fetch existing state from the database to merge with incoming state
      const existingRecord = await userOnboardingRepository.findByUserId(userId);
      let dbState = {};
      if (existingRecord && existingRecord.data) {
        dbState = existingRecord.data;
      }

      if (!state || Object.keys(state).length === 0) {
        state = dbState;
        if (Object.keys(state).length > 0) {
          console.log(`[OnboardingController] [userId=${userId}] Restored state from database.`);
        }
      } else {
        // Deep merge incoming state into dbState so we don't lose preferredLanguage etc.
        // Clean up null/undefined from top level to prevent overwriting valid db values
        const incomingStateCleaned = Object.fromEntries(
          Object.entries(state).filter(([_, v]) => v !== null && v !== undefined),
        );

        const incomingExistingUserData = incomingStateCleaned.existingUserData;
        state = { ...dbState, ...incomingStateCleaned };

        if (incomingExistingUserData && dbState.existingUserData) {
          const incomingUserDataCleaned = Object.fromEntries(
            Object.entries(incomingExistingUserData).filter(
              ([_, v]) => v !== null && v !== undefined,
            ),
          );
          state.existingUserData = { ...dbState.existingUserData, ...incomingUserDataCleaned };
        }

        // Safeguard: explicitly restore crucial routing state if it somehow still got wiped out
        if (!state.currentStep && dbState.currentStep) state.currentStep = dbState.currentStep;
        if (!state.flowMode && dbState.flowMode) state.flowMode = dbState.flowMode;
        if (!state.preferredLanguage && dbState.preferredLanguage)
          state.preferredLanguage = dbState.preferredLanguage;
      }

      console.log(
        `[OnboardingController] [userId=${userId}] Before Ollama API call at ${new Date().toISOString()}`,
      );

      const beforeOllamaTime = Date.now();
      const result = await onboardingService.chat(
        message,
        history,
        state,
        userId,
        null,
        displayLabel,
      );
      const ollamaResponseTime = Date.now();

      console.log(
        `[OnboardingController] [userId=${userId}] Ollama response received at ${new Date(ollamaResponseTime).toISOString()}`,
      );
      console.log(
        `[OnboardingController] [userId=${userId}] Ollama latency: ${ollamaResponseTime - beforeOllamaTime}ms`,
      );

      const totalTime = Date.now() - requestReceivedTime;
      console.log(`[OnboardingController] [userId=${userId}] Total execution time: ${totalTime}ms`);

      return result;
    } catch (error) {
      const errorTime = Date.now();
      const totalTime = errorTime - requestReceivedTime;
      console.error(`[OnboardingController] Onboarding chat failed after ${totalTime}ms:`);
      console.error(`Error Code: ${error.code || "N/A"}`);
      console.error(`Error Message: ${error.message}`);
      console.error(`Error Stack: ${error.stack}`);
      throw error;
    }
  }

  async getOnboardingStatus(userId) {
    if (!userId) {
      throw new UnauthorizedException("Unauthorized access");
    }

    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException("Patient not found");
    }

    // Get saved onboarding state for resumption
    const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
    const resumableState = onboardingRecord?.data || null;
    if (resumableState && resumableState.preferredLanguage) {
      resumableState.preferredLanguage = normalizeLanguage(resumableState.preferredLanguage);
    }
    let currentStep = resumableState?.currentStep || "ASK_LANGUAGE";

    const isStateCompleted = resumableState?.isOnboardingCompleted === true;

    const isBasicProfileComplete = !!(
      patient.firstName &&
      patient.firstName !== "User" &&
      patient.lastName &&
      patient.gender &&
      patient.dateOfBirth
    );

    let isOnboardingCompleted = false;

    // If we have an onboarding record, trust its completion status
    if (resumableState) {
      isOnboardingCompleted = patient.onboardingCompleted || isStateCompleted;
    } else {
      // Fallback for users without an onboarding record (legacy)
      isOnboardingCompleted = patient.onboardingCompleted || isBasicProfileComplete;
    }

    // If onboarding is considered complete, return completed status
    if (isOnboardingCompleted) {
      if (currentStep !== "POST_ONBOARDING") {
        currentStep = "COMPLETE";
      }
      return {
        isOnboardingCompleted: true,
        currentStep,
        chatSessionId: resumableState?.chatSessionId || null,
        resumableState,
      };
    }

    return {
      isOnboardingCompleted: false,
      currentStep,
      chatSessionId: resumableState?.chatSessionId || null,
      resumableState,
    };
  }

  async getOnboardingHistory(userId) {
    if (!userId) {
      throw new UnauthorizedException("Unauthorized access");
    }

    const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
    const resumableState = onboardingRecord?.data || null;
    if (resumableState && resumableState.preferredLanguage) {
      resumableState.preferredLanguage = normalizeLanguage(resumableState.preferredLanguage);
    }
    const chatSessionId = resumableState?.chatSessionId || null;

    let messages = [];
    if (chatSessionId) {
      const result = await chatSessionRepository.listMessages({
        sessionId: chatSessionId,
        userId,
        limit: 100,
        direction: "after",
      });
      messages = result.items || [];
    }

    return {
      chatSessionId,
      messages,
      currentStep: resumableState?.currentStep || "ASK_LANGUAGE",
      resumableState,
    };
  }
}

module.exports = new V1Service();
