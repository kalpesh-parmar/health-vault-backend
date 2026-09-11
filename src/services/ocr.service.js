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
const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");
const patientRepository = require("../repositories/patientRepository");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const {
  onboardingService,
  canSkipOnboarding,
  saveOnboardingState,
} = require("./ai/chat/onboarding.service");
const { ocrService } = require("./ai/ocr/ocr.service");
const uploadFileService = require("./uploadFile.service");
const { normalizeLanguage } = require("../utils/commonUtils");
const {
  normalizeCreateMedicationInput,
  normalizeMedicine,
} = require("../helpers/medicineNormalize.helper");
const { messageConstants } = require("../constants/messageConstants");
const { errorConstants } = require("../constants/errorConstants");
const { inferFileType } = require("../helpers/document.helper");
const documentPersistenceService = require("./documentPersistence.service");
const documentOcrJobService = require("./documentOcrJob.service");
const medicationService = require("./medication.service");
const medicationReminderService = require("./medicationReminder.service");
const { chatService } = require("./ai/chat/chat.service");
const {
  buildUnifiedResponse,
  detectActionIntent,
  executeAddDocumentAction,
  normalizeUnifiedChatInput,
} = require("../helpers/unifiedChat.helper");
const { and, eq, desc } = require("drizzle-orm");
const medicationRepository = require("../repositories/medicationRepository");

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

    let structData = docRow.structuredExtractedData;
    if (typeof structData === "string") {
      try {
        structData = JSON.parse(structData);
      } catch {
        structData = {};
      }
    }
    const summary =
      docRow.summaryInPreferredLanguage ||
      docRow.summaryEnglish ||
      structData?.summaryEnglish ||
      structData?.summary ||
      structData?.remarks ||
      "";

    return {
      documentId: docRow.id,
      status,
      summary,
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

  async onboardingChat(userId, body, onChunk = null, abortSignal = null) {
    const requestReceivedTime = Date.now();
    console.log(
      `[UnifiedChat] Request received at ${new Date(requestReceivedTime).toISOString()} for userId=${userId}`,
    );

    try {
      if (!userId) {
        throw new UnauthorizedException("Unauthorized access");
      }

      const normalizedInput = normalizeUnifiedChatInput(body);
      const {
        actionType,
        actionData,
        message,
        sessionId,
        documentId,
        state: inputState,
        history,
        displayLabel,
        preferredLanguage,
      } = normalizedInput;

      // Fetch user profile and existing onboarding state
      const patient = await patientRepository.findById(userId);
      const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
      const dbState = onboardingRecord?.data || {};
      const isOnboardingCompleted =
        patient?.onboardingCompleted ||
        dbState?.isOnboardingCompleted === true ||
        dbState?.currentStep === "COMPLETE" ||
        dbState?.currentStep === "POST_ONBOARDING" ||
        inputState?.isOnboardingCompleted === true ||
        inputState?.currentStep === "COMPLETE" ||
        inputState?.currentStep === "POST_ONBOARDING";

      console.log(
        `[ONBOARDING PROFILE LOG] User ID: ${userId} | Patient DB Record: firstName="${patient?.firstName || ""}", lastName="${patient?.lastName || ""}", email="${patient?.email || ""}"`,
      );

      // CASE 1: ADD_DOCUMENT ACTION
      if (actionType === "ADD_DOCUMENT") {
        console.log(`[UnifiedChat] Executing ADD_DOCUMENT action for userId=${userId}`);
        const userPrefLang =
          patient?.preferredLanguage ||
          inputState?.preferredLanguage ||
          dbState?.preferredLanguage ||
          "english";
        return executeAddDocumentAction({
          userId,
          actionData,
          sessionId,
          preferredLanguage: userPrefLang,
          isOnboardingCompleted,
          documentPersistenceService,
          documentOcrJobService,
          chatService,
          chatSessionRepository,
          ocrStatusEnum: ocrStatus,
        });
      }

      const cleanedInputState =
        inputState && typeof inputState === "object"
          ? Object.fromEntries(
              Object.entries(inputState).filter(([_, v]) => v !== null && v !== undefined),
            )
          : {};
      const effectiveState = { ...(dbState || {}), ...cleanedInputState };

      let isMedicineSelectionMsg = false;
      if (message) {
        try {
          const parsedMsg = typeof message === "string" ? JSON.parse(message) : message;
          if (
            parsedMsg &&
            (parsedMsg.selected !== undefined ||
              parsedMsg.action === "CONFIRM" ||
              parsedMsg.value === "CONFIRM" ||
              parsedMsg.value === "CONFIRM_SELECTED")
          ) {
            isMedicineSelectionMsg = true;
          }
        } catch {
          const upper = String(message).trim().toUpperCase();
          if (upper === "CONFIRM" || upper === "CONFIRM_SELECTED") {
            isMedicineSelectionMsg = true;
          }
        }
      }

      let isAddMedicineMsg = false;
      if (message || actionType === "ADD_MEDICINE") {
        try {
          const parsedMsg = typeof message === "string" ? JSON.parse(message) : message;
          if (
            parsedMsg &&
            (parsedMsg.key === "ADD" ||
              parsedMsg.value === "ADD" ||
              parsedMsg.action === "ADD" ||
              parsedMsg.actionType === "ADD_MEDICINE" ||
              parsedMsg.addNew === true)
          ) {
            isAddMedicineMsg = true;
          }
        } catch {
          // Ignore JSON parse error
        }

        const msgStr = String(message || "")
          .trim()
          .toUpperCase();
        const actStr = String(actionType || "")
          .trim()
          .toUpperCase();

        if (
          actStr === "ADD_MEDICINE" ||
          msgStr === "ADD" ||
          msgStr === "ADD_NEW" ||
          msgStr.includes("ADD ANOTHER MEDICINE") ||
          msgStr.includes("ADD MEDICINE") ||
          msgStr.includes("ADD NEW")
        ) {
          isAddMedicineMsg = true;
        }
      }

      let currentOnboardingStep = effectiveState?.currentStep || null;
      const hasUnconfirmedMedicines =
        !isOnboardingCompleted &&
        Array.isArray(effectiveState?.medicinesToAdd) &&
        effectiveState.medicinesToAdd.length > 0 &&
        effectiveState?.medicinesConfirmed !== true;

      if (isAddMedicineMsg) {
        currentOnboardingStep = "ADD_MEDICINE";
        effectiveState.currentStep = "ADD_MEDICINE";
      } else if (isMedicineSelectionMsg || (!currentOnboardingStep && hasUnconfirmedMedicines)) {
        currentOnboardingStep = "REVIEW_MEDICINES_LIST";
        effectiveState.currentStep = "REVIEW_MEDICINES_LIST";
      }

      const isActiveOnboardingStep =
        (!isOnboardingCompleted ||
          (isOnboardingCompleted && !effectiveState?.medicationFlowDone)) &&
        ((Boolean(currentOnboardingStep) &&
          currentOnboardingStep !== "COMPLETE" &&
          currentOnboardingStep !== "POST_ONBOARDING" &&
          effectiveState?.medicationFlowDone !== true) ||
          isAddMedicineMsg ||
          hasUnconfirmedMedicines);

      // CASE 2: MEDICINE ACTIONS (ADD_MEDICINE, CONFIRM_MEDICINES, SKIP_MEDICINES, REVIEW_MEDICINES_LIST, SHOW_EXTRACTED_MEDICINES)
      const hasMedicineActionData =
        actionData &&
        typeof actionData === "object" &&
        (actionData.medicationName || actionData.name || actionData.medicine);

      const isMedicineAction =
        actionType === "CONFIRM_MEDICINES" ||
        actionType === "SKIP_MEDICINES" ||
        actionType === "REVIEW_MEDICINES_LIST" ||
        actionType === "SHOW_EXTRACTED_MEDICINES" ||
        isMedicineSelectionMsg ||
        isAddMedicineMsg ||
        hasMedicineActionData ||
        (actionData && Array.isArray(actionData.medicines) && actionData.medicines.length > 0);

      if (isMedicineAction) {
        console.log(
          `[UnifiedChat] Executing medicine action '${actionType}' for userId=${userId} (isActiveOnboardingStep=${isActiveOnboardingStep})`,
        );

        const isSkipAction =
          actionType === "SKIP_MEDICINES" ||
          String(message || "").toUpperCase() === "SKIP" ||
          actionData?.skipAll === true;

        if (isSkipAction && !isActiveOnboardingStep) {
          const replyText = messageConstants.MEDICATIONS_REVIEW_SKIPPED;
          let activeSessionId = sessionId;
          if (!activeSessionId && isOnboardingCompleted) {
            const newSession = await chatService.createSession({
              userId,
              title: "Medication Chat",
            });
            activeSessionId = newSession?.id || null;
          }

          if (activeSessionId) {
            await chatSessionRepository.appendMessage({
              sessionId: activeSessionId,
              userId,
              role: "assistant",
              content: replyText,
              metadata: { actionType: "SKIP_MEDICINES" },
            });
          }

          return buildUnifiedResponse({
            mode: "ACTION",
            actionType: "SKIP_MEDICINES",
            reply: replyText,
            sessionId: activeSessionId,
          });
        }

        if (isAddMedicineMsg && !hasMedicineActionData && !isActiveOnboardingStep) {
          let activeSessionId = sessionId;
          if (!activeSessionId && isOnboardingCompleted) {
            const newSession = await chatService.createSession({
              userId,
              title: "Medication Chat",
            });
            activeSessionId = newSession?.id || null;
          }

          return buildUnifiedResponse({
            mode: "ACTION",
            actionType: "ADD_MEDICINE",
            reply: "Please enter the medication details:",
            sessionId: activeSessionId,
            options: [{ label: "Cancel", value: "CANCEL", actionType: "CANCEL" }],
          });
        }

        let createdMeds = [];
        let medsToProcess =
          Array.isArray(actionData?.medicines) && actionData.medicines.length > 0
            ? actionData.medicines
            : Array.isArray(body?.medicines) && body.medicines.length > 0
              ? body.medicines
              : null;

        // Parse message JSON string if payload sent in message body
        if (!medsToProcess && typeof message === "string" && message.trim().startsWith("{")) {
          try {
            const parsedMsg = JSON.parse(message);
            if (Array.isArray(parsedMsg?.medicines) && parsedMsg.medicines.length > 0) {
              medsToProcess = parsedMsg.medicines;
            } else if (parsedMsg?.medicine && typeof parsedMsg.medicine === "object") {
              medsToProcess = [parsedMsg.medicine];
            } else if (Array.isArray(parsedMsg?.selected) && parsedMsg.selected.length > 0) {
              medsToProcess = parsedMsg.selected.map((sItem) =>
                typeof sItem === "object" ? sItem : { id: sItem, selected: true },
              );
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Post-onboarding fallback: if reviewing or confirming post-onboarding document medications and medsToProcess is still empty
        if (
          !isActiveOnboardingStep &&
          (!medsToProcess || medsToProcess.length === 0) &&
          userId &&
          (actionType === "CONFIRM_MEDICINES" ||
            actionType === "REVIEW_MEDICINES_LIST" ||
            actionType === "SHOW_EXTRACTED_MEDICINES" ||
            String(message || "").toUpperCase() === "CONFIRM" ||
            String(message || "").toUpperCase() === "CONFIRM_SELECTED")
        ) {
          try {
            const [latestDoc] = await db
              .select()
              .from(document)
              .where(and(eq(document.userId, userId), eq(document.ocrStatus, "completed")))
              .orderBy(desc(document.createdAt))
              .limit(1);

            if (latestDoc && latestDoc.structuredExtractedData) {
              const struct = latestDoc.structuredExtractedData;
              const extracted = struct.medications || struct.structuredData?.medications || [];
              if (Array.isArray(extracted) && extracted.length > 0) {
                const todayStr = new Date().toISOString().slice(0, 10);
                medsToProcess = extracted.map((m, idx) => {
                  const { row, onboardingMed } = normalizeMedicine(m, idx, "P-TEMP", {
                    startDate: todayStr,
                  });
                  return {
                    id: m.id || m.client_med_id || onboardingMed.id,
                    client_med_id: m.client_med_id || onboardingMed.client_med_id,
                    name: onboardingMed.name,
                    medicationName: onboardingMed.name,
                    medicationType: onboardingMed.type,
                    type: onboardingMed.type,
                    dosePerIntake: row.dosePerIntake || 1,
                    frequency: onboardingMed.frequency,
                    duration: onboardingMed.duration,
                    instructions: m.instructions || m.timing || row.notes || null,
                    notes: row.notes || null,
                    startDate: row.startDate,
                    endDate: row.endDate,
                    foodFrequency: row.foodFrequency,
                    medicationSchedule: onboardingMed.medicationSchedule,
                    totalQuantity: row.totalQuantity,
                    unit: row.unit,
                    dailyConsumption: row.dailyConsumption,
                    prescribedBy: row.prescribedBy || null,
                    refillAlert: row.refillAlert || false,
                    selected: true,
                    isSaved: false,
                  };
                });
              }
            }
          } catch (docLookupErr) {
            console.warn(
              "[UnifiedChat] Post-onboarding document lookup warning:",
              docLookupErr.message,
            );
          }
        }

        // Handle REVIEW_MEDICINES_LIST / SHOW_EXTRACTED_MEDICINES post-onboarding: duplicate check & return review list
        if (
          !isActiveOnboardingStep &&
          (actionType === "REVIEW_MEDICINES_LIST" || actionType === "SHOW_EXTRACTED_MEDICINES") &&
          Array.isArray(medsToProcess) &&
          medsToProcess.length > 0
        ) {
          const checkedMeds = await medicationService.checkDuplicateMedicationsBatch(
            userId,
            medsToProcess,
          );
          const replyText = `We found ${checkedMeds.length} medication${checkedMeds.length === 1 ? "" : "s"} for your review.`;

          let activeSessionId = sessionId;
          if (!activeSessionId && isOnboardingCompleted) {
            const newSession = await chatService.createSession({
              userId,
              title: "Medication Chat",
            });
            activeSessionId = newSession?.id || null;
          }

          if (activeSessionId) {
            await chatSessionRepository.appendMessage({
              sessionId: activeSessionId,
              userId,
              role: "assistant",
              content: replyText,
              metadata: {
                mode: "ACTION",
                actionType: "REVIEW_MEDICINES_LIST",
                medicines: checkedMeds,
              },
            });
          }

          return buildUnifiedResponse({
            mode: "ACTION",
            actionType: "REVIEW_MEDICINES_LIST",
            reply: replyText,
            sessionId: activeSessionId,
            medicines: checkedMeds,
            options: [
              { label: "Confirm Selected", value: "CONFIRM", actionType: "CONFIRM_MEDICINES" },
              { label: "Add New", value: "ADD", actionType: "ADD_MEDICINE" },
              { label: "Skip All", value: "SKIP", actionType: "SKIP_MEDICINES" },
            ],
          });
        }

        if (!isActiveOnboardingStep && Array.isArray(medsToProcess) && medsToProcess.length > 0) {
          for (const rawMedData of medsToProcess) {
            let medData =
              typeof rawMedData === "object" && rawMedData !== null
                ? { ...rawMedData }
                : { id: rawMedData, selected: true };

            if (medData.selected === false || medData.resolution === "REMOVE_NEW") {
              continue;
            }

            if (medData.resolution === "KEEP_EXISTING") {
              const matchedId =
                medData.replaceMedicationId ||
                medData.targetMedicationId ||
                medData.duplicateInfo?.matchedMedication?.id ||
                medData.matchedMedicationId;
              if (matchedId) {
                try {
                  const existingMed = await medicationRepository.findById(matchedId);
                  if (existingMed) {
                    createdMeds.push(existingMed);
                  }
                } catch (kErr) {
                  console.warn("[UnifiedChat] KEEP_EXISTING lookup warning:", kErr.message);
                }
              }
              continue;
            }

            const targetId =
              medData.replaceMedicationId ||
              medData.targetMedicationId ||
              medData.duplicateInfo?.matchedMedication?.id ||
              medData.matchedMedicationId;

            if (medData.resolution === "REPLACE" && targetId) {
              try {
                await medicationService.deleteMedication(targetId, userId);
              } catch (delErr) {
                console.warn(
                  `[UnifiedChat] Soft-delete warning for replaced med ${targetId}:`,
                  delErr.message,
                );
              }
            }

            if (!medData.name && !medData.medicationName && userId) {
              try {
                const matchId =
                  typeof rawMedData === "string" ? rawMedData : medData.id || medData.client_med_id;

                const parseMedicineMatchId = (matchIdStr) => {
                  if (!matchIdStr || typeof matchIdStr !== "string") return null;
                  const compoundRegex =
                    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-med-(\d+)-(.*)$/i;
                  const match = matchIdStr.trim().match(compoundRegex);
                  if (match) {
                    const rawName = match[3]
                      .replace(/([a-z])([A-Z])/g, "$1 $2")
                      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
                      .trim();
                    return {
                      documentId: match[1],
                      index: parseInt(match[2], 10),
                      name: rawName,
                    };
                  }
                  return null;
                };

                const parsedCompound = parseMedicineMatchId(matchId);

                let foundInDoc = null;
                const candidateSources = [
                  effectiveState?.foundMedicines,
                  effectiveState?.medicinesToAdd,
                  effectiveState?.medicines,
                  actionData?.foundMedicines,
                  actionData?.medicinesList,
                  body?.state?.foundMedicines,
                  body?.state?.medicinesToAdd,
                ].filter((arr) => Array.isArray(arr) && arr.length > 0);

                const findMedicineByMatchId = (medsArray, matchIdVal) => {
                  if (!Array.isArray(medsArray) || medsArray.length === 0 || !matchIdVal)
                    return null;
                  const matchStr = String(matchIdVal).trim();
                  const compound = parseMedicineMatchId(matchStr);

                  if (compound && compound.index >= 0 && compound.index < medsArray.length) {
                    return medsArray[compound.index];
                  }

                  const directMatch = medsArray.find(
                    (m, idx) =>
                      m &&
                      (String(m.id || "") === matchStr ||
                        String(m.client_med_id || "") === matchStr ||
                        String(m.clientMedId || "") === matchStr ||
                        `extracted_med_${idx + 1}` === matchStr ||
                        `doc_med_${idx + 1}` === matchStr ||
                        `extracted_med_${idx}` === matchStr ||
                        `doc_med_${idx}` === matchStr),
                  );
                  if (directMatch) return directMatch;

                  if (compound && compound.name) {
                    const cleanCompName = compound.name.toLowerCase().replace(/\s+/g, "");
                    const nameMatch = medsArray.find(
                      (m) =>
                        m &&
                        (m.name || m.medicationName) &&
                        String(m.name || m.medicationName)
                          .toLowerCase()
                          .replace(/\s+/g, "") === cleanCompName,
                    );
                    if (nameMatch) return nameMatch;
                  }

                  const numMatch = matchStr.match(/(?:extracted_med_|doc_med_)?(\d+)/i);
                  if (numMatch) {
                    const parsedNum = parseInt(numMatch[1], 10);
                    if (!isNaN(parsedNum)) {
                      if (parsedNum >= 1 && parsedNum <= medsArray.length) {
                        return medsArray[parsedNum - 1];
                      }
                      if (parsedNum >= 0 && parsedNum < medsArray.length) {
                        return medsArray[parsedNum];
                      }
                    }
                  }
                  return null;
                };

                for (const sourceArr of candidateSources) {
                  foundInDoc = findMedicineByMatchId(sourceArr, matchId);
                  if (foundInDoc) break;
                }

                if (!foundInDoc) {
                  const targetDocId =
                    parsedCompound?.documentId ||
                    (Array.isArray(body?.documentId) ? body.documentId[0] : body?.documentId) ||
                    (Array.isArray(actionData?.documentId)
                      ? actionData.documentId[0]
                      : actionData?.documentId) ||
                    effectiveState?.documentId;

                  const UUID_REGEX =
                    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

                  let docRecord = null;
                  if (
                    targetDocId &&
                    UUID_REGEX.test(String(targetDocId)) &&
                    userId &&
                    UUID_REGEX.test(String(userId))
                  ) {
                    const [matchedDoc] = await db
                      .select()
                      .from(document)
                      .where(
                        and(eq(document.id, targetDocId), eq(document.userId, String(userId))),
                      );
                    docRecord = matchedDoc;
                  }

                  if (!docRecord && userId && UUID_REGEX.test(String(userId))) {
                    const [latestDoc] = await db
                      .select()
                      .from(document)
                      .where(
                        and(
                          eq(document.userId, String(userId)),
                          eq(document.ocrStatus, "completed"),
                        ),
                      )
                      .orderBy(desc(document.createdAt))
                      .limit(1);
                    docRecord = latestDoc;
                  }

                  if (docRecord && docRecord.structuredExtractedData) {
                    const struct = docRecord.structuredExtractedData;
                    const docMeds = struct.medications || struct.structuredData?.medications || [];
                    foundInDoc = findMedicineByMatchId(docMeds, matchId);
                  }
                }

                if (foundInDoc) {
                  const normDocMed = normalizeMedicine(foundInDoc, 0);
                  medData = {
                    ...normDocMed.row,
                    ...foundInDoc,
                    ...medData,
                    name:
                      medData.name ||
                      medData.medicationName ||
                      foundInDoc.name ||
                      foundInDoc.medicationName ||
                      parsedCompound?.name ||
                      "Medical Document Medicine",
                    medicationName:
                      medData.name ||
                      medData.medicationName ||
                      foundInDoc.name ||
                      foundInDoc.medicationName ||
                      parsedCompound?.name ||
                      "Medical Document Medicine",
                    medicationType: String(
                      medData.type ||
                        medData.medicationType ||
                        foundInDoc.type ||
                        foundInDoc.medicationType ||
                        "TABLET",
                    ).toUpperCase(),
                    type: String(
                      medData.type ||
                        medData.medicationType ||
                        foundInDoc.type ||
                        foundInDoc.medicationType ||
                        "TABLET",
                    ).toUpperCase(),
                    dosePerIntake:
                      medData.dosePerIntake ||
                      (foundInDoc.dosage ? parseFloat(foundInDoc.dosage) || 1 : 1),
                    frequency: medData.frequency || foundInDoc.frequency || "ONCE",
                    duration: medData.duration || foundInDoc.duration || null,
                    instructions:
                      medData.instructions ||
                      medData.notes ||
                      foundInDoc.instructions ||
                      foundInDoc.timing ||
                      null,
                    startDate:
                      medData.startDate ||
                      foundInDoc.startDate ||
                      new Date().toISOString().split("T")[0],
                  };
                } else if (parsedCompound && parsedCompound.name) {
                  medData.name = parsedCompound.name;
                  medData.medicationName = parsedCompound.name;
                }
              } catch (lookupErr) {
                console.warn("[UnifiedChat] Document lookup for med ID failed:", lookupErr.message);
              }
            }

            if (!medData.name && !medData.medicationName) {
              const matchIdStr = String(medData.id || "");
              if (matchIdStr.startsWith("extracted_med_") || matchIdStr.startsWith("doc_med_")) {
                medData.name = "Medical Document Medicine";
                medData.medicationName = "Medical Document Medicine";
              } else if (matchIdStr.trim().length > 0) {
                medData.name = matchIdStr.replace(/[{}[\]"]/g, "").trim();
                medData.medicationName = medData.name;
              } else {
                continue;
              }
            }

            try {
              const normalizedMedData = normalizeCreateMedicationInput(medData);
              const med = await medicationService.createMedication(userId, normalizedMedData, {
                skipDuplicateCheck: true,
              });
              if (med && med.id) {
                createdMeds.push(med);
                try {
                  await medicationReminderService.createReminder(userId, { medicationId: med.id });
                } catch (rErr) {
                  console.error("[UnifiedChat] Error creating reminder for bulk medicine:", rErr);
                }
              }
            } catch (mErr) {
              console.error("[UnifiedChat] Error creating individual medicine from list:", mErr);
            }
          }
        } else if (hasMedicineActionData) {
          const normalizedActionData = normalizeCreateMedicationInput(actionData);
          const createdMed = await medicationService.createMedication(
            userId,
            normalizedActionData,
            {
              skipDuplicateCheck: true,
            },
          );
          if (createdMed && createdMed.id) {
            createdMeds.push(createdMed);
            try {
              await medicationReminderService.createReminder(userId, {
                medicationId: createdMed.id,
              });
            } catch (e) {
              console.error("[UnifiedChat] Error creating reminder:", e);
            }
          }
        }
        const createdMed = createdMeds[0] || null;

        // If patient is in active Onboarding medicine loop, update state and advance onboarding
        if (isActiveOnboardingStep) {
          const stateToUpdate = { ...effectiveState };
          if (!stateToUpdate.medicinesToAdd) stateToUpdate.medicinesToAdd = [];

          if (createdMeds.length > 0) {
            for (const med of createdMeds) {
              stateToUpdate.medicinesToAdd.push({
                name: med.medicationName,
                id: med.id,
                client_med_id: med.clientMedId || med.id,
                selected: true,
                isSaved: true,
                dbId: med.id,
              });
            }
            stateToUpdate.medicinesConfirmed = true;
            stateToUpdate.medicinesSavedToDb = true;
            stateToUpdate.medicationFlowDone = true;
          }

          if (actionType === "CONFIRM_MEDICINES" || stateToUpdate.medicinesConfirmed) {
            stateToUpdate.medicinesConfirmed = true;
            stateToUpdate.medicationFlowDone = true;
          } else {
            stateToUpdate.currentStep = "MEDICINE_OPTIONS";
          }

          const onboardingResult = await onboardingService.chat(
            message || "",
            history,
            stateToUpdate,
            userId,
            null,
            displayLabel,
          );

          const responsePayload = buildUnifiedResponse({
            mode: "ONBOARDING",
            actionType: onboardingResult?.action || "MEDICINE_OPTIONS",
            reply: onboardingResult?.message || onboardingResult?.reply || "",
            onboardingState: onboardingResult?.state || stateToUpdate,
            options: onboardingResult?.options || [],
            medicines: onboardingResult?.medicines || [],
          });
          responsePayload.canSkip =
            onboardingResult?.canSkip !== undefined
              ? onboardingResult.canSkip
              : canSkipOnboarding(onboardingResult?.state || stateToUpdate);
          return responsePayload;
        }

        // Post-Onboarding (Dashboard Chat Stream): return confirmation response
        const replyText =
          createdMeds.length > 0
            ? messageConstants.MEDICATIONS_CONFIRMED_SUCCESS
            : createdMed?.name
              ? `Medication '${createdMed.name}' has been added to your active medications.`
              : "Medication processed successfully.";

        let activeSessionId = sessionId;
        if (!activeSessionId && isOnboardingCompleted) {
          const newSession = await chatService.createSession({ userId, title: "Medication Chat" });
          activeSessionId = newSession?.id || null;
        }

        if (activeSessionId) {
          await chatSessionRepository.appendMessage({
            sessionId: activeSessionId,
            userId,
            role: "assistant",
            content: replyText,
            metadata: {
              mode: "ACTION",
              actionType: "CONFIRM_MEDICINES",
              medicationIds: createdMeds.map((m) => m.id),
              medicines: createdMeds,
              medication: createdMed,
            },
          });
        }

        return buildUnifiedResponse({
          mode: "ACTION",
          actionType: "CONFIRM_MEDICINES",
          reply: replyText,
          sessionId: activeSessionId,
          medication: createdMed,
          medicines: createdMeds,
        });
      }

      // Determine if request should route to Normal Post-Onboarding Chat vs Onboarding State Machine
      const isCompletedStep =
        effectiveState?.currentStep === "COMPLETE" ||
        effectiveState?.currentStep === "POST_ONBOARDING";

      const data = dbState?.existingUserData || inputState?.existingUserData || {};
      const bloodGroup = patient?.bloodGroup || data?.bloodGroup;
      const allergies = patient?.allergies || data?.allergies;
      const bloodGroupSkipped =
        dbState?.bloodGroupSkipped === true || inputState?.bloodGroupSkipped === true;
      const allergiesSkipped =
        dbState?.allergiesSkipped === true || inputState?.allergiesSkipped === true;

      const isSkippedValid =
        (dbState?.hasSkipped === true ||
          inputState?.hasSkipped === true ||
          effectiveState?.hasSkipped === true) &&
        canSkipOnboarding(effectiveState || dbState || inputState);

      const hasUnansweredOptional =
        isOnboardingCompleted &&
        ((!bloodGroup && !bloodGroupSkipped) ||
          ((!allergies || allergies.length === 0) && !allergiesSkipped));

      const isMedicationFlowPending =
        !isOnboardingCompleted &&
        dbState?.medicationFlowDone !== true &&
        inputState?.medicationFlowDone !== true &&
        effectiveState?.medicationFlowDone !== true;

      const isForcedOnboardingAction =
        message === "ASK_REPORT" ||
        message === "ASK_ABOUT_REPORT" ||
        actionType === "ASK_REPORT" ||
        inputState?.currentStep === "ASK_REPORT";

      const isNormalChat =
        !isForcedOnboardingAction &&
        actionType !== "SKIP_ONBOARDING" &&
        !hasUnansweredOptional &&
        !isMedicationFlowPending &&
        (actionType === "NORMAL_CHAT" ||
          ((isOnboardingCompleted ||
            isCompletedStep ||
            isSkippedValid ||
            dbState?.currentStep === "ASK_REPORT" ||
            inputState?.currentStep === "ASK_REPORT") &&
            !isActiveOnboardingStep &&
            message !== "ASK_REPORT" &&
            (actionType !== "ONBOARDING" ||
              isCompletedStep ||
              isSkippedValid ||
              dbState?.currentStep === "ASK_REPORT" ||
              inputState?.currentStep === "ASK_REPORT") &&
            actionType !== "OTHER_ACTIONS"));

      // CASE 3: ONBOARDING STATE MACHINE FLOW
      if (!isNormalChat) {
        console.log(`[UnifiedChat] Executing Onboarding State Machine for userId=${userId}`);
        let state = inputState;
        if (!state || Object.keys(state).length === 0) {
          state = dbState;
        } else {
          const incomingStateCleaned = Object.fromEntries(
            Object.entries(state).filter(([_, v]) => v !== null && v !== undefined && v !== ""),
          );

          const dbExistingUserData = dbState?.existingUserData || {};
          const incomingExistingUserData = incomingStateCleaned.existingUserData || {};
          const incomingUserDataCleaned = Object.fromEntries(
            Object.entries(incomingExistingUserData).filter(
              ([_, v]) => v !== null && v !== undefined && v !== "",
            ),
          );

          const bloodGroupSkipped =
            dbState?.bloodGroupSkipped === true || incomingStateCleaned.bloodGroupSkipped === true;
          const allergiesSkipped =
            dbState?.allergiesSkipped === true || incomingStateCleaned.allergiesSkipped === true;

          const documentOwnershipConfirmed =
            incomingStateCleaned.documentOwnershipConfirmed !== undefined &&
            incomingStateCleaned.documentOwnershipConfirmed !== null
              ? incomingStateCleaned.documentOwnershipConfirmed
              : dbState?.documentOwnershipConfirmed !== undefined &&
                  dbState?.documentOwnershipConfirmed !== null
                ? dbState.documentOwnershipConfirmed
                : null;

          const documentConfirmed =
            documentOwnershipConfirmed === true ||
            dbState?.documentConfirmed === true ||
            incomingStateCleaned.documentConfirmed === true;

          const useDocumentData =
            dbState?.useDocumentData === true ||
            incomingStateCleaned.useDocumentData === true ||
            (documentConfirmed && dbState?.useDocumentData !== false);

          const isDocUploaded =
            dbState?.documentUploaded === true ||
            dbState?.uploadedMedicalDocument === true ||
            incomingStateCleaned.documentUploaded === true ||
            incomingStateCleaned.uploadedMedicalDocument === true ||
            incomingStateCleaned.documentAttachedToChat === true ||
            Boolean(incomingStateCleaned.documentId || dbState?.documentId);

          const isProfileConfirmedInDb =
            dbState?.profileConfirmed === true || !!dbState?.selectedProfileSource;

          const mergedUserData =
            isProfileConfirmedInDb && !incomingStateCleaned.edited
              ? {
                  ...incomingUserDataCleaned,
                  ...dbExistingUserData,
                  ...(incomingUserDataCleaned.bloodGroup
                    ? { bloodGroup: incomingUserDataCleaned.bloodGroup }
                    : {}),
                  ...(Array.isArray(incomingUserDataCleaned.allergies) &&
                  incomingUserDataCleaned.allergies.length > 0
                    ? { allergies: incomingUserDataCleaned.allergies }
                    : {}),
                }
              : {
                  ...dbExistingUserData,
                  ...incomingUserDataCleaned,
                  ...(incomingUserDataCleaned.bloodGroup
                    ? { bloodGroup: incomingUserDataCleaned.bloodGroup }
                    : {}),
                  ...(Array.isArray(incomingUserDataCleaned.allergies) &&
                  incomingUserDataCleaned.allergies.length > 0
                    ? { allergies: incomingUserDataCleaned.allergies }
                    : {}),
                };

          state = {
            ...dbState,
            ...incomingStateCleaned,
            bloodGroupSkipped,
            allergiesSkipped,
            ...(isDocUploaded ? { documentUploaded: true, uploadedMedicalDocument: true } : {}),
            ...(documentConfirmed !== undefined && documentConfirmed !== null
              ? { documentConfirmed }
              : {}),
            ...(documentOwnershipConfirmed !== undefined && documentOwnershipConfirmed !== null
              ? { documentOwnershipConfirmed }
              : {}),
            ...(useDocumentData !== undefined && useDocumentData !== null
              ? { useDocumentData }
              : {}),
            existingUserData: mergedUserData,
          };

          if (!state.currentStep && dbState.currentStep) state.currentStep = dbState.currentStep;
          if (!state.flowMode && dbState.flowMode) state.flowMode = dbState.flowMode;
          if (!state.preferredLanguage && dbState.preferredLanguage)
            state.preferredLanguage = dbState.preferredLanguage;
        }

        if (hasUnansweredOptional && actionType !== "SKIP_ONBOARDING") {
          state.currentStep = null;
        }

        if (actionType === "SKIP_ONBOARDING") {
          if (!canSkipOnboarding(state)) {
            throw new InvalidRequestException(errorConstants.REQUIRED_PROFILE_DETAILS_MISSING);
          }
          state.isOnboardingCompleted = true;
          state.hasSkipped = true;
          if (!state.currentStep && dbState && dbState.currentStep) {
            state.currentStep = dbState.currentStep;
          }

          await saveOnboardingState(userId, state);

          const responsePayload = buildUnifiedResponse({
            mode: "ONBOARDING",
            actionType: "SKIP_ONBOARDING",
            reply: "",
            onboardingState: state,
            options: [],
            medicines: [],
          });
          responsePayload.canSkip = true;
          return responsePayload;
        }

        const onboardingResult = await onboardingService.chat(
          message,
          history,
          state,
          userId,
          null,
          displayLabel,
        );

        const replyText =
          onboardingResult?.title && onboardingResult?.message
            ? `${onboardingResult.title}\n\n${onboardingResult.message}`
            : onboardingResult?.message || onboardingResult?.reply || "";
        console.log(replyText);

        const responsePayload = buildUnifiedResponse({
          mode: "ONBOARDING",
          actionType:
            actionType === "SKIP_ONBOARDING"
              ? "SKIP_ONBOARDING"
              : onboardingResult?.action || "ONBOARDING_STEP",
          reply: onboardingResult.message,
          title: onboardingResult?.title || null,
          subtitle: onboardingResult?.subtitle || null,
          fields: onboardingResult?.fields || [],
          explainer: onboardingResult?.explainer || null,
          loginSummary: onboardingResult?.loginSummary || null,
          documentSummary: onboardingResult?.documentSummary || null,
          onboardingState: onboardingResult?.state || state,
          options: onboardingResult?.options || [],
          medicines: onboardingResult?.medicines || [],
          document: onboardingResult?.document || null,
        });
        if (onboardingResult?.completionMessage) {
          responsePayload.completionMessage = onboardingResult.completionMessage;
        }
        responsePayload.suggestedQuestions = onboardingResult?.suggestedQuestions || [];
        responsePayload.canSkip =
          onboardingResult?.canSkip !== undefined
            ? onboardingResult.canSkip
            : canSkipOnboarding(onboardingResult?.state || state);
        return responsePayload;
      }

      // CASE 4: NORMAL_CHAT (Post-onboarding RAG Chat)
      console.log(`[UnifiedChat] Executing Normal Chat / RAG query for userId=${userId}`);
      const userLang = preferredLanguage || patient?.preferredLanguage || "english";
      const promptText = message && message.trim().length > 0 ? message.trim() : "Hello";

      const intentResult = detectActionIntent(promptText, userLang);

      const chatResult = await chatService.sendMessage({
        userId,
        question: promptText,
        sessionId,
        documentId,
        preferredLanguage: userLang,
        onChunk,
        abortSignal,
      });

      return buildUnifiedResponse({
        mode: "NORMAL_CHAT",
        actionType: chatResult?.requireSelection ? "REQUIRE_DOCUMENT_SELECTION" : "NORMAL_CHAT",
        reply: chatResult?.reply || chatResult?.answer || chatResult?.message || "",
        sessionId: chatResult?.ai?.sessionId || chatResult?.sessionId || sessionId,
        citations: chatResult?.citations || [],
        suggestedAction: chatResult?.requireSelection
          ? "REQUIRE_DOCUMENT_SELECTION"
          : intentResult.suggestedAction,
        options: intentResult.options.length > 0 ? intentResult.options : chatResult?.options || [],
        requireSelection: chatResult?.requireSelection || false,
        reports: chatResult?.reports || [],
        allowMultiSelect: chatResult?.allowMultiSelect || false,
        selectionType: chatResult?.selectionType || null,
      });
    } catch (error) {
      console.error(`[UnifiedChat] Unified chat processing error for userId=${userId}:`, error);
      throw error;
    }
  }

  // TODO: move onboarding status/history out of ocr.service.js
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

    const canSkip = resumableState ? canSkipOnboarding(resumableState) : false;

    // If onboarding is considered complete, return completed status
    if (isOnboardingCompleted) {
      if (currentStep !== "POST_ONBOARDING") {
        currentStep = "COMPLETE";
      }
      return {
        isOnboardingCompleted: true,
        currentStep,
        chatSessionId: resumableState?.chatSessionId || null,
        resumableState: resumableState ? { ...resumableState, canSkip } : null,
        canSkip,
      };
    }

    return {
      isOnboardingCompleted: false,
      currentStep,
      chatSessionId: resumableState?.chatSessionId || null,
      resumableState: resumableState ? { ...resumableState, canSkip } : null,
      canSkip,
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

    let documentsName = [];
    let documentSummary = { totalUploads: 0, completed: 0, failed: 0, rejected: 0 };
    try {
      const jobNames = await documentProcessingJobRepository.findUserJobDocumentNames(userId);
      if (jobNames && jobNames.length > 0) {
        documentsName = jobNames;
      } else {
        const userDocs = await documentRepository.findAllByFilterAndSort({
          filter: {},
          sort: { sortBy: "createdAt", sortOrder: "desc" },
          userId,
        });
        documentsName = (userDocs || []).map((doc) => doc.fileName).filter(Boolean);
      }

      const summaryFromDb = await documentProcessingJobRepository.getUserJobSummary(userId);
      if (summaryFromDb) {
        documentSummary = {
          totalUploads: summaryFromDb.totalUploads || 0,
          completed: summaryFromDb.completed || 0,
          failed: summaryFromDb.failed || 0,
          rejected: summaryFromDb.rejected || 0,
        };
      }
    } catch (_err) {
      console.log(_err);

      documentsName = [];
    }

    return {
      chatSessionId,
      messages,
      documentsName,
      documentSummary,
      currentStep: resumableState?.currentStep || "ASK_LANGUAGE",
      resumableState,
    };
  }
}
module.exports = new V1Service();
