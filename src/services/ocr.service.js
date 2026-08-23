const { eq, and, desc } = require("drizzle-orm");

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
const { normalizeCreateMedicationInput } = require("../helpers/medicineNormalize.helper");
const { messageConstants } = require("../constants/messageConstants");
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
        return executeAddDocumentAction({
          userId,
          actionData,
          sessionId,
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
        !isOnboardingCompleted &&
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

        // Post-onboarding fallback: if confirming post-onboarding document medications and medsToProcess is still empty
        if (
          !isActiveOnboardingStep &&
          (!medsToProcess || medsToProcess.length === 0) &&
          userId &&
          (actionType === "CONFIRM_MEDICINES" ||
            actionType === "REVIEW_MEDICINES_LIST" ||
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
                medsToProcess = extracted.map((m, idx) => ({
                  id: m.id || m.client_med_id || `doc_med_${idx}`,
                  name: m.name || m.medicationName || "Medical Document Medicine",
                  medicationName: m.name || m.medicationName || "Medical Document Medicine",
                  medicationType: String(m.type || m.medicationType || "TABLET").toUpperCase(),
                  type: String(m.type || m.medicationType || "TABLET").toUpperCase(),
                  dosePerIntake: m.dosage ? parseFloat(m.dosage) || 1 : 1,
                  frequency: m.frequency || "ONCE",
                  duration: m.duration || null,
                  instructions: m.instructions || m.timing || null,
                  selected: true,
                }));
              }
            }
          } catch (docLookupErr) {
            console.warn(
              "[UnifiedChat] Post-onboarding document lookup warning:",
              docLookupErr.message,
            );
          }
        }

        if (!isActiveOnboardingStep && Array.isArray(medsToProcess) && medsToProcess.length > 0) {
          for (const rawMedData of medsToProcess) {
            let medData =
              typeof rawMedData === "object" && rawMedData !== null
                ? { ...rawMedData }
                : { id: rawMedData, selected: true };

            if (
              medData.selected === false ||
              medData.resolution === "KEEP_EXISTING" ||
              medData.resolution === "REMOVE_NEW"
            ) {
              continue;
            }

            if (
              medData.resolution === "REPLACE" &&
              (medData.replaceMedicationId || medData.targetMedicationId)
            ) {
              const targetId = medData.replaceMedicationId || medData.targetMedicationId;
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
                const [latestDoc] = await db
                  .select()
                  .from(document)
                  .where(and(eq(document.userId, userId), eq(document.ocrStatus, "completed")))
                  .orderBy(desc(document.createdAt))
                  .limit(1);

                if (latestDoc && latestDoc.structuredExtractedData) {
                  const struct = latestDoc.structuredExtractedData;
                  const docMeds = struct.medications || struct.structuredData?.medications || [];
                  const matchId =
                    typeof rawMedData === "string"
                      ? rawMedData
                      : medData.id || medData.client_med_id;
                  const foundInDoc = docMeds.find(
                    (m, idx) =>
                      m.id === matchId ||
                      m.client_med_id === matchId ||
                      `extracted_med_${idx + 1}` === matchId ||
                      `doc_med_${idx}` === matchId,
                  );

                  if (foundInDoc) {
                    medData = {
                      ...foundInDoc,
                      ...medData,
                      name:
                        foundInDoc.name || foundInDoc.medicationName || "Medical Document Medicine",
                      medicationName:
                        foundInDoc.name || foundInDoc.medicationName || "Medical Document Medicine",
                      medicationType: String(
                        foundInDoc.type || foundInDoc.medicationType || "TABLET",
                      ).toUpperCase(),
                      type: String(
                        foundInDoc.type || foundInDoc.medicationType || "TABLET",
                      ).toUpperCase(),
                      dosePerIntake: foundInDoc.dosage ? parseFloat(foundInDoc.dosage) || 1 : 1,
                      frequency: foundInDoc.frequency || "ONCE",
                      duration: foundInDoc.duration || null,
                      instructions: foundInDoc.instructions || foundInDoc.timing || null,
                    };
                  }
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
              } else {
                // Skip raw database UUIDs or unrecognized string IDs lacking a medication name
                continue;
              }
            }

            try {
              const normalizedMedData = normalizeCreateMedicationInput(medData);
              const med = await medicationService.createMedication(userId, normalizedMedData);
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
          const createdMed = await medicationService.createMedication(userId, normalizedActionData);
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

          return buildUnifiedResponse({
            mode: "ONBOARDING",
            actionType: onboardingResult?.action || "MEDICINE_OPTIONS",
            reply: onboardingResult?.message || onboardingResult?.reply || "",
            onboardingState: onboardingResult?.state || stateToUpdate,
            options: onboardingResult?.options || [],
            medicines: onboardingResult?.medicines || [],
          });
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
      const isNormalChat =
        actionType === "NORMAL_CHAT" ||
        ((isOnboardingCompleted || isCompletedStep) &&
          !isActiveOnboardingStep &&
          (actionType !== "ONBOARDING" || isCompletedStep) &&
          actionType !== "OTHER_ACTIONS");

      // CASE 3: ONBOARDING STATE MACHINE FLOW
      if (!isNormalChat) {
        console.log(`[UnifiedChat] Executing Onboarding State Machine for userId=${userId}`);
        let state = inputState;
        if (!state || Object.keys(state).length === 0) {
          state = dbState;
        } else {
          const incomingStateCleaned = Object.fromEntries(
            Object.entries(state).filter(([_, v]) => v !== null && v !== undefined),
          );

          const dbExistingUserData = dbState?.existingUserData || {};
          const incomingExistingUserData = incomingStateCleaned.existingUserData || {};
          const incomingUserDataCleaned = Object.fromEntries(
            Object.entries(incomingExistingUserData).filter(
              ([_, v]) => v !== null && v !== undefined,
            ),
          );

          const bloodGroupSkipped =
            dbState?.bloodGroupSkipped === true || incomingStateCleaned.bloodGroupSkipped === true;
          const allergiesSkipped =
            dbState?.allergiesSkipped === true || incomingStateCleaned.allergiesSkipped === true;

          const documentConfirmed =
            dbState?.documentConfirmed === true ||
            dbState?.documentOwnershipConfirmed === true ||
            incomingStateCleaned.documentConfirmed === true ||
            incomingStateCleaned.documentOwnershipConfirmed === true;

          const documentOwnershipConfirmed =
            dbState?.documentOwnershipConfirmed === true ||
            incomingStateCleaned.documentOwnershipConfirmed === true;

          const useDocumentData =
            dbState?.useDocumentData === true ||
            incomingStateCleaned.useDocumentData === true ||
            (documentConfirmed && dbState?.useDocumentData !== false);

          const mergedUserData = {
            ...dbExistingUserData,
            ...incomingUserDataCleaned,
            bloodGroup: incomingUserDataCleaned.bloodGroup || dbExistingUserData.bloodGroup || null,
            allergies:
              Array.isArray(incomingUserDataCleaned.allergies) &&
              incomingUserDataCleaned.allergies.length > 0
                ? incomingUserDataCleaned.allergies
                : dbExistingUserData.allergies || [],
          };

          state = {
            ...dbState,
            ...incomingStateCleaned,
            bloodGroupSkipped,
            allergiesSkipped,
            ...(documentConfirmed ? { documentConfirmed: true } : {}),
            ...(documentOwnershipConfirmed ? { documentOwnershipConfirmed: true } : {}),
            ...(useDocumentData ? { useDocumentData: true } : {}),
            existingUserData: mergedUserData,
          };

          if (!state.currentStep && dbState.currentStep) state.currentStep = dbState.currentStep;
          if (!state.flowMode && dbState.flowMode) state.flowMode = dbState.flowMode;
          if (!state.preferredLanguage && dbState.preferredLanguage)
            state.preferredLanguage = dbState.preferredLanguage;
        }

        const onboardingResult = await onboardingService.chat(
          message,
          history,
          state,
          userId,
          null,
          displayLabel,
        );

        return buildUnifiedResponse({
          mode: "ONBOARDING",
          actionType: onboardingResult?.action || "ONBOARDING_STEP",
          reply: onboardingResult?.message || onboardingResult?.reply || "",
          onboardingState: onboardingResult?.state || state,
          options: onboardingResult?.options || [],
          medicines: onboardingResult?.medicines || [],
        });
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
