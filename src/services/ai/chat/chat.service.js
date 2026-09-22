const { env } = require("../../../configs/env");
const { messageConstants } = require("../../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../../exceptions/appError");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { eq, desc, inArray, and } = require("drizzle-orm");
const { ocrStatus } = require("../../../enums/ocrStatus");
const { normalizeDocumentType } = require("../../../enums/documentType");
const { ollamaClient } = require("../../../clients/ollamaClient");
const { embeddingService } = require("./embedding.service");
const prompts = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const medicationRepository = require("../../../repositories/medicationRepository");
const documentRepository = require("../../../repositories/documentRepository");
const occurrenceRepository = require("../../../repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../../repositories/notificationRepository");
const authProviderRepository = require("../../../repositories/authProviderRepository");

const aiClient = require("../clients/aiClient.service");
const { getAgeFromDateOfBirth } = require("../../../helpers/dateHelper");
const { normalizeLanguage } = require("../../../utils/commonUtils");
const { containsEntity } = require("../../../utils/synonyms");
const { toDbDateOnlyString } = require("../../../utils/dateUtils");
const { calculateRemainingQuantity } = require("../../../utils/remainingQuantityCalculation");
const { triageService, EMERGENCY_WARNING_I18N } = require("./triage.service");
const {
  ragContextService,
  getMedicalEntityKeywords,
  getReportAgeString,
  buildDependencyAwareContext,
  paginateArray,
} = require("./ragContext.service");

const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");
const { pickLang, hasAny, toIsoDateOnly } = require("./chatHelpers");

const { debugLogger } = require("../../../utils/debugLogger");
const keywordDictionary = require("../../../constants/keywordDictionary");
const {
  NO_CONTEXT_REPLY_I18N,
  REQUIRE_SELECTION_I18N,
  AGE_REPLY_I18N,
  SUMMARY_LABELS_I18N,
  REPORT_PROCESSING_I18N,
  NO_REPORT_FOUND_I18N,
  NO_SUMMARY_AVAILABLE_I18N,
  PREDEFINED_QUESTIONS_I18N,
  PROFILE_REPLY_I18N,
  REMINDER_REPLY_I18N,
  REFILL_REPLY_I18N,
  NOTIFICATION_REPLY_I18N,
} = require("../../../constants/chatReplies");

const NO_CONTEXT_REPLY = "Information not found in uploaded reports.";
// const MIN_CITATION_RELEVANCE = 0.7; // cosine similarity ≥ 0.3 distance ≤ 0.7

async function streamTextLikeChat(text, onChunk, abortSignal, delayMs = 15) {
  if (!text || !onChunk) return;
  const words = text.split(/(\s+)/);
  for (const word of words) {
    if (abortSignal?.aborted) break;
    onChunk(word);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

const AGE_KEYWORDS = keywordDictionary.AGE;
const SUMMARY_KEYWORDS = keywordDictionary.SUMMARY;
const MEDICATION_LIST_KEYWORDS = keywordDictionary.MEDICATION_LIST;

function isProfileQuestion(question = "") {
  const q = String(question || "")
    .toLowerCase()
    .trim();

  const isDocPatientQuestion = hasAny(q, keywordDictionary.PROFILE_EXCLUSIONS);

  if (isDocPatientQuestion) return false;

  return hasAny(q, keywordDictionary.PROFILE);
}

function detectDocumentStatusFilter(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .trim();
  if (!t) return null;
  if (
    keywordDictionary.DOCUMENT_STATUS?.FAILED &&
    hasAny(t, keywordDictionary.DOCUMENT_STATUS.FAILED)
  ) {
    return "FAILED";
  }
  if (
    keywordDictionary.DOCUMENT_STATUS?.REJECTED &&
    hasAny(t, keywordDictionary.DOCUMENT_STATUS.REJECTED)
  ) {
    return "REJECTED";
  }
  if (
    keywordDictionary.DOCUMENT_STATUS?.COMPLETED &&
    hasAny(t, keywordDictionary.DOCUMENT_STATUS.COMPLETED)
  ) {
    return "COMPLETED";
  }
  if (
    keywordDictionary.DOCUMENT_STATUS?.PENDING &&
    hasAny(t, keywordDictionary.DOCUMENT_STATUS.PENDING)
  ) {
    return "PENDING";
  }
  return null;
}

function detectDocumentTypeFilter(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .trim();
  if (!t) return null;
  if (keywordDictionary.DOCUMENT_TYPES_I18N) {
    for (const [typeKey, keywords] of Object.entries(keywordDictionary.DOCUMENT_TYPES_I18N)) {
      if (hasAny(t, keywords)) {
        return typeKey;
      }
    }
  }
  return null;
}

const processingSessions = new Set();

class ChatService {
  detectEmergency(text) {
    return triageService.detectEmergency(text);
  }

  _appendLanguageInstruction(systemPrompt, normLang) {
    const instructionContent = pickLang(prompts.STRICT_LANGUAGE_INSTRUCTIONS, normLang);
    return `${systemPrompt}\n\n${instructionContent}`;
  }

  async _callLLM(messages, onChunk, abortSignal) {
    const options = {
      temperature: 0.2,
      maxTokens: 4096,
      think: false,
      rawOptions: {
        num_ctx: env.ollamaNumCtx,
        repeat_penalty: 1.2,
        repeat_last_n: 64,
      },
      signal: abortSignal,
    };

    let answer = "";
    let resObj = null;

    if (onChunk) {
      resObj = await ollamaClient.chatStream(
        messages,
        env.chatModel,
        (chunk) => {
          answer += chunk;
          onChunk(chunk);
        },
        options,
      );
    } else {
      answer = await ollamaClient.chat(messages, env.chatModel, options);
    }

    return { answer, resObj };
  }

  async _appendUserMessage({ userId, sessionId, question }) {
    return chatSessionRepository.appendMessage({
      content: question.trim(),
      role: "user",
      sessionId,
      userId,
    });
  }

  async _saveExchange({ userId, sessionId, question, content, metadata, citations }) {
    const userMessage = await this._appendUserMessage({ userId, sessionId, question });
    const aiMessage = await chatSessionRepository.appendMessage({
      citations: citations || [],
      content,
      metadata,
      role: "assistant",
      sessionId,
      userId,
    });
    return { userMessage, aiMessage };
  }

  async qwenHealthChat(
    messages,
    mode,
    contextChunks = [],
    patientContextStr = "",
    preferredLanguage = "english",
    coverageStr = "",
    onChunk = null,
    abortSignal = null,
  ) {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const userQuery = lastUserMessage?.content || "";
    const normLang = normalizeLanguage(preferredLanguage);

    if (this.detectEmergency(userQuery)) {
      return {
        answer: pickLang(EMERGENCY_WARNING_I18N, normLang),
        mode,
        emergency: true,
        citations: [],
      };
    }

    if (mode === "DOCUMENT_RAG") {
      const defaultNoContext = pickLang(NO_CONTEXT_REPLY_I18N, normLang);
      if (!contextChunks || contextChunks.length === 0) {
        return {
          answer: defaultNoContext,
          mode,
          emergency: false,
          citations: [],
        };
      }

      const medicalEntities = getMedicalEntityKeywords(userQuery);

      // Group context chunks by document ID
      const chunksByDoc = new Map();
      for (const chunk of contextChunks) {
        const docId = String(chunk.documentId);
        if (!chunksByDoc.has(docId)) {
          chunksByDoc.set(docId, []);
        }
        chunksByDoc.get(docId).push(chunk);
      }

      const contextText = Array.from(chunksByDoc.entries())
        .map(([, chunks]) => {
          const docData = chunks[0].docData || {};
          let pName = "Unknown";
          if (docData.structuredExtractedData?.patient?.name) {
            pName = docData.structuredExtractedData.patient.name;
          }
          const fileName = docData.fileName || "Unknown";
          const reportDate = docData.reportDate
            ? toDbDateOnlyString(docData.reportDate) || "Unknown"
            : "Unknown";

          // Fallback context: extract matching structured summary tests if present
          let structuredTestsStr = "";
          if (
            medicalEntities.length > 0 &&
            docData.structuredExtractedData?.tests &&
            Array.isArray(docData.structuredExtractedData.tests)
          ) {
            const relevantTests = docData.structuredExtractedData.tests.filter((t) => {
              const testNameLower = t.name?.toLowerCase() || "";
              return medicalEntities.some((entity) => {
                return containsEntity(testNameLower, entity);
              });
            });

            if (relevantTests.length > 0) {
              structuredTestsStr =
                `Requested Medical Information:\n` +
                relevantTests
                  .map((t) => `- ${t.name}: ${t.value} ${t.unit || ""} (${t.status || "NORMAL"})`)
                  .join("\n");
            }
          }

          const chunksContent = chunks
            .map((c) => `[Section: ${c.sectionTitle || "General"}]\n${c.content}`)
            .join("\n\n");

          return `=== REPORT ===
Document: ${fileName}
Report Date: ${reportDate}
Patient Name Printed on Document: ${pName}

${structuredTestsStr ? structuredTestsStr + "\n\n" : ""}Evidence:
${chunksContent}`;
        })
        .join("\n\n========================================\n\n");

      let systemPrompt = prompts.RAG_PROMPT_TEMPLATE(contextText, normLang, coverageStr);

      const uniqueDocsCount = new Set(contextChunks.map((c) => c.documentId)).size;
      systemPrompt += `\n\nIMPORTANT DOCUMENT COUNT INSTRUCTION: You have been provided with extracted context from EXACTLY ${uniqueDocsCount} distinct medical report(s). If asked for an overview, summary, or total count of reports, you MUST state that there are exactly ${uniqueDocsCount} report(s). Do NOT hallucinate any other number.`;

      if (patientContextStr) {
        systemPrompt += `\n\n${patientContextStr}`;
      }
      systemPrompt = this._appendLanguageInstruction(systemPrompt, normLang);

      // eslint-disable-next-line no-console
      console.log("========== RAG DEBUG START ==========");
      // eslint-disable-next-line no-console
      console.log("userQuery:", userQuery);
      // eslint-disable-next-line no-console
      console.log("contextChunks.length:", contextChunks ? contextChunks.length : 0);
      // eslint-disable-next-line no-console
      console.log("unique document count:", uniqueDocsCount);
      // eslint-disable-next-line no-console
      console.log("contextText.length:", contextText ? contextText.length : 0);
      // eslint-disable-next-line no-console
      console.log("systemPrompt.length:", systemPrompt ? systemPrompt.length : 0);
      // eslint-disable-next-line no-console
      console.log("messages.length:", messages ? messages.length : 0);
      if (Array.isArray(messages)) {
        messages.forEach((msg, idx) => {
          // eslint-disable-next-line no-console
          console.log(
            `Incoming Message [${idx}] - Role: ${msg.role}, Length: ${msg.content ? msg.content.length : 0}`,
          );
          // eslint-disable-next-line no-console
          console.log(`Incoming Message [${idx}] Content:\n${msg.content}`);
        });
      }
      // eslint-disable-next-line no-console
      console.log("========== RAG DEBUG END ==========");

      const formattedMessages =
        Array.isArray(messages) && messages.length > 0
          ? [{ role: "system", content: systemPrompt }, ...messages]
          : [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: userQuery,
              },
            ];

      const totalPromptCharCount = formattedMessages.reduce(
        (sum, m) => sum + (m.content ? m.content.length : 0),
        0,
      );

      // eslint-disable-next-line no-console
      console.log("========== OLLAMA REQUEST DEBUG ==========");
      // eslint-disable-next-line no-console
      console.log("Model:", env.chatModel);
      // eslint-disable-next-line no-console
      console.log("Number of messages:", formattedMessages.length);
      formattedMessages.forEach((m, idx) => {
        // eslint-disable-next-line no-console
        console.log(
          `Message [${idx}] Index: ${idx}, Role: ${m.role}, Length: ${m.content ? m.content.length : 0}`,
        );
      });
      // eslint-disable-next-line no-console
      console.log("Total prompt character count:", totalPromptCharCount);
      // eslint-disable-next-line no-console
      console.log("Full messages payload:", JSON.stringify(formattedMessages, null, 2));
      // eslint-disable-next-line no-console
      console.log("========== OLLAMA REQUEST END ==========");

      // eslint-disable-next-line no-console
      console.log(
        `[ChatService] Running local RAG chat (generation in ${normLang}) using ${env.chatModel}...`,
      );

      const { answer, resObj } = await this._callLLM(formattedMessages, onChunk, abortSignal);

      // eslint-disable-next-line no-console
      console.log("========== OLLAMA RESPONSE DEBUG ==========");
      // eslint-disable-next-line no-console
      console.log("Response model:", resObj?.model || env.chatModel);
      // eslint-disable-next-line no-console
      console.log("Generated answer:", answer);
      // eslint-disable-next-line no-console
      console.log("prompt_eval_count:", resObj?.prompt_eval_count ?? "N/A");
      // eslint-disable-next-line no-console
      console.log("eval_count:", resObj?.eval_count ?? "N/A");
      // eslint-disable-next-line no-console
      console.log("done:", resObj?.done ?? true);
      // eslint-disable-next-line no-console
      console.log("========== OLLAMA RESPONSE END ==========");
      return {
        answer,
        mode,
        emergency: false,
        citations: contextChunks,
      };
    }

    let systemPrompt = prompts.GENERAL_HEALTH_PROMPT(normLang);
    if (patientContextStr) {
      systemPrompt += `\n\n${patientContextStr}`;
    }

    systemPrompt = this._appendLanguageInstruction(systemPrompt, normLang);
    const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

    // eslint-disable-next-line no-console
    console.log(
      `[ChatService] Running local general chat (generation in ${normLang}) using ${env.chatModel}...`,
    );

    const { answer } = await this._callLLM(formattedMessages, onChunk, abortSignal);

    return {
      answer,
      mode,
      emergency: false,
      citations: [],
    };
  }

  async createSession({ userId, documentId, title }) {
    return chatSessionRepository.createSession({
      documentId: documentId || null,
      lastMessageAt: new Date(),
      title: title?.slice(0, 255) || "New chat",
      userId,
    });
  }

  async listSessions({ userId, cursor, limit }) {
    return chatSessionRepository.listSessions({ cursor, limit, userId });
  }

  async listMessages({ sessionId, userId, cursor, limit, direction }) {
    const session = await chatSessionRepository.findSessionById(sessionId, userId);
    if (!session) {
      throw new NotFoundException(
        messageConstants.SESSION_FETCHED ? "Chat session not found" : "Not found",
      );
    }
    const result = await chatSessionRepository.listMessages({
      cursor,
      direction,
      limit,
      sessionId,
      userId,
    });

    const items = (result.items || []).map((msg) => {
      const meta = msg.metadata || {};
      return {
        ...msg,
        actionType: meta.actionType || msg.actionType || null,
        options: meta.options || msg.options || [],
        medicines: meta.medicines || msg.medicines || [],
        document: meta.document || msg.document || null,
        suggestedAction: meta.suggestedAction || msg.suggestedAction || null,
        mode: meta.mode || msg.mode || null,
        medication: meta.medication || msg.medication || null,
      };
    });

    return { ...result, items };
  }

  async _resolveQuestion(ctx) {
    let { question, documentId, reqSessionId, userId } = ctx;
    if (!question?.trim()) {
      if (documentId && documentId.length > 0) {
        let lookupSessionId = reqSessionId;
        if (!lookupSessionId) {
          const existingSessions = await chatSessionRepository.listSessions({ userId, limit: 1 });
          if (existingSessions?.items?.length > 0) {
            lookupSessionId = existingSessions.items[0].id;
          }
        }
        if (lookupSessionId) {
          const recentMsgs = await chatSessionRepository.listMessages({
            direction: "before",
            limit: 10,
            sessionId: lookupSessionId,
            userId,
          });
          const lastUserMsg = (recentMsgs?.items || []).find((m) => m.role === "user");
          if (lastUserMsg && lastUserMsg.content) {
            question = lastUserMsg.content;
            debugLogger.info("sendMessage: Re-using previous question from session", {
              question,
            });
          }
        }
      }
    }

    if (!question?.trim()) {
      throw new InvalidRequestException("Question is required");
    }

    ctx.question = question;
    ctx.cleanQuestion = question.toLowerCase().replace(/[?.]/g, "").trim();
    ctx.retrievalQuery = question;
  }

  async _resolveLanguage(ctx) {
    const { userId, passedLang, question } = ctx;
    const p = await patientRepository.findById(userId);
    ctx.p = p;

    // Resolve and normalize preferred language
    let preferredLanguage = passedLang || "english";
    if (!passedLang) {
      if (p) {
        preferredLanguage = p.preferredLanguage || "english";
      }
      if (!preferredLanguage || preferredLanguage === "english") {
        try {
          const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
          if (onboardingRecord?.data?.preferredLanguage) {
            preferredLanguage = onboardingRecord.data.preferredLanguage;
          }
        } catch (err) {
          debugLogger.error("sendMessage: Failed to get onboarding preferredLanguage", {
            error: err.message,
          });
        }
      }
    }
    preferredLanguage = normalizeLanguage(preferredLanguage);
    ctx.patientPreferredLang = preferredLanguage;

    // --- ML LANGUAGE DETECTION ---
    let detectedLanguage = preferredLanguage;
    try {
      const detectStartTime = Date.now();
      const detectedLang = await aiClient.detectLanguage(question);
      const detectDuration = Date.now() - detectStartTime;
      if (detectedLang) {
        const normDetected = normalizeLanguage(detectedLang);
        debugLogger.info(`sendMessage: [LANGUAGE DETECTION] took ${detectDuration}ms`, {
          detected: normDetected,
          previous: preferredLanguage,
        });
        detectedLanguage = normDetected;
      }
    } catch (err) {
      debugLogger.error("sendMessage: Failed to detect language via ML model", {
        error: err.message,
      });
    }

    // Force everything to use detectedLanguage
    ctx.detectedLanguage = detectedLanguage;
    ctx.preferredLanguage = detectedLanguage;
  }

  async _resolveSession(ctx) {
    const { reqSessionId, userId, documentId } = ctx;
    let session;
    if (reqSessionId) {
      session = await chatSessionRepository.findSessionById(reqSessionId, userId);
      if (!session) throw new NotFoundException("Chat session not found");
    } else {
      const existingSessions = await chatSessionRepository.listSessions({ userId, limit: 1 });
      if (existingSessions && existingSessions.items && existingSessions.items.length > 0) {
        session = existingSessions.items[0];
      } else {
        session = await chatSessionRepository.createSession({
          userId,
          title: "Health Chat",
          metadata: { active_document_ids: documentId || [] },
        });
      }
    }
    ctx.session = session;
    ctx.sessionId = session.id;
  }

  async _tryIntercepts(ctx) {
    const {
      cleanQuestion,
      detectedLanguage,
      patientPreferredLang,
      p,
      userId,
      sessionId,
      question,
      documentId,
      onChunk,
      abortSignal,
      retrievalQuery,
    } = ctx;

    // Intercept 1: Age
    if (AGE_KEYWORDS.includes(cleanQuestion)) {
      const ageTemplates = pickLang(AGE_REPLY_I18N, detectedLanguage);
      let interceptedReply = null;
      if (p && p.dateOfBirth) {
        const dobStr = toIsoDateOnly(p.dateOfBirth);
        const calculatedAge = getAgeFromDateOfBirth(p.dateOfBirth);
        interceptedReply = ageTemplates.success(dobStr, calculatedAge);
      } else {
        interceptedReply = ageTemplates.missing;
      }

      const { userMessage: userMsg, aiMessage: aiMsg } = await this._saveExchange({
        userId,
        sessionId,
        question,
        content: interceptedReply,
        metadata: { mode: "GENERAL_HEALTH", emergency: false, intercepted: true, documentId: [] },
        citations: [],
      });
      return {
        ai: aiMsg,
        citations: [],
        reply: interceptedReply,
        user: userMsg,
        mode: "GENERAL_HEALTH",
        emergency: false,
      };
    }

    // Intercept 2: Summary
    const isSummaryRequest = hasAny(cleanQuestion, SUMMARY_KEYWORDS);
    if (isSummaryRequest) {
      let targetDoc = null;
      if (documentId && documentId.length > 0) {
        const docs = await db
          .select()
          .from(document)
          .where(
            and(
              eq(document.id, documentId[0]),
              eq(document.userId, userId),
              eq(document.softDelete, false),
            ),
          )
          .limit(1);
        if (docs.length > 0) {
          targetDoc = docs[0];
        }
      } else {
        const docs = await db
          .select()
          .from(document)
          .where(and(eq(document.userId, userId), eq(document.softDelete, false)))
          .orderBy(desc(document.createdAt))
          .limit(1);
        if (docs.length > 0) {
          targetDoc = docs[0];
        }
      }

      const userMessage = await this._appendUserMessage({
        userId,
        sessionId,
        question,
      });

      let replyText = "";
      let options = [];
      let taskMode = "DOCUMENT_RAG";

      if (!targetDoc) {
        replyText = pickLang(NO_REPORT_FOUND_I18N, patientPreferredLang);
        if (onChunk) {
          onChunk(replyText);
        }
      } else if (
        targetDoc.ocrStatus === ocrStatus.PENDING ||
        targetDoc.ocrStatus === ocrStatus.IN_PROGRESS ||
        targetDoc.ocrStatus === "processing"
      ) {
        replyText = pickLang(REPORT_PROCESSING_I18N, patientPreferredLang);
        if (onChunk) {
          onChunk(replyText);
        }
      } else {
        const patientName =
          targetDoc.structuredExtractedData?.patient?.name ||
          targetDoc.structuredExtractedData?.patientName ||
          (p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "Unknown");

        const reportAgeStr = getReportAgeString(
          targetDoc.reportDate || targetDoc.createdAt,
          patientPreferredLang,
        );

        let structData = targetDoc.structuredExtractedData;
        if (typeof structData === "string") {
          try {
            structData = JSON.parse(structData);
          } catch {
            structData = {};
          }
        }
        let rawSummary =
          targetDoc.summaryEnglish ||
          structData?.summaryEnglish ||
          structData?.summary ||
          structData?.remarks ||
          "";

        const labels = pickLang(SUMMARY_LABELS_I18N, patientPreferredLang);
        const questions = pickLang(PREDEFINED_QUESTIONS_I18N, patientPreferredLang);

        const formattedHeader =
          `**${labels.patientName}:** ${patientName}\n` +
          `**${labels.reportAge}:** ${reportAgeStr}\n\n` +
          `### ${labels.summaryTitle}\n`;

        if (onChunk) {
          await streamTextLikeChat(formattedHeader, onChunk, abortSignal, 10);
        }

        let translatedSummaryParts = [];
        if (!rawSummary) {
          const noSummary = pickLang(NO_SUMMARY_AVAILABLE_I18N, patientPreferredLang);
          translatedSummaryParts.push(noSummary);
          if (onChunk) {
            await streamTextLikeChat(noSummary, onChunk, abortSignal, 15);
          }
        } else {
          // Split by double newline first to get paragraphs
          const rawParagraphs = rawSummary.split("\n\n");
          for (let i = 0; i < rawParagraphs.length; i++) {
            if (abortSignal?.aborted) break;
            const rawPara = rawParagraphs[i];
            if (!rawPara.trim()) continue;

            if (onChunk && i > 0) {
              // If it is not the first paragraph of the summary, prefix with double newline
              onChunk("\n\n");
            }

            let fullTranslatedPara = "";

            if (patientPreferredLang !== "english") {
              // Split paragraph into sentences to stream translation faster
              const sentences = rawPara.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [rawPara];

              for (let s = 0; s < sentences.length; s++) {
                if (abortSignal?.aborted) break;
                let rawSentence = sentences[s];
                if (!rawSentence.trim()) continue;

                let translatedSentence = rawSentence;
                try {
                  translatedSentence = await aiClient.translate(
                    rawSentence.trim(),
                    "english",
                    patientPreferredLang,
                  );
                } catch (err) {
                  debugLogger.error("sendMessage: Sentence translation failed", {
                    error: err.message,
                  });
                }

                // Add space before next sentence if not first and doesn't start with space
                if (s > 0 && !translatedSentence.startsWith(" ")) {
                  translatedSentence = " " + translatedSentence;
                }

                fullTranslatedPara += translatedSentence;
                if (onChunk) {
                  await streamTextLikeChat(translatedSentence, onChunk, abortSignal, 15);
                }
              }
            } else {
              fullTranslatedPara = rawPara;
              if (onChunk) {
                await streamTextLikeChat(fullTranslatedPara, onChunk, abortSignal, 15);
              }
            }

            translatedSummaryParts.push(fullTranslatedPara);
          }
        }

        replyText = formattedHeader + translatedSummaryParts.join("\n\n");

        options = questions.map((q) => ({
          label: q,
          value: q,
          actionType: "CHAT",
        }));
      }

      const aiMessage = await chatSessionRepository.appendMessage({
        citations: [],
        content: replyText,
        metadata: {
          mode: taskMode,
          emergency: false,
          documentId: targetDoc ? [targetDoc.id] : [],
          task: "SUMMARY",
          options,
        },
        role: "assistant",
        sessionId,
        userId,
      });

      return {
        ai: aiMessage,
        citations: [],
        reply: replyText,
        user: userMessage,
        mode: taskMode,
        emergency: false,
        options,
      };
    }

    const lowerQuestion = retrievalQuery.toLowerCase();
    const normalizedQuestion = lowerQuestion
      .replace(/\bliist\b/g, "list")
      .replace(/\bremaing\b/g, "remaining")
      .replace(/\bquntity\b/g, "quantity");

    // Intercept 3: Profile Query (Direct from DB - No LLM)
    const isProfile = isProfileQuestion(cleanQuestion) || isProfileQuestion(normalizedQuestion);
    if (isProfile) {
      return await this._handleProfileIntercept(ctx);
    }

    // Explicit keywords for Reminders & Today's Schedule
    const explicitReminderKeywords = [
      "reminder",
      "reminders",
      "missed dose",
      "taken dose",
      "skipped dose",
      "dose schedule",
      "today's schedule",
      "today schedule",
      "today's medication",
      "today medication",
      "today's medicine",
      "today medicine",
      "today's medications",
      "today medications",
      "today medicines",
      "today's medicines",
      "today medication list",
      "today medicine list",
      "today's medication list",
      "today's medicine list",
      "medications today",
      "medicines today",
      "remind me",
      "doses today",
      "schedule today",
      "overdue dose",
      "આજની દવાઓ",
      "આજની દવાઓની યાદી",
      "આજના રિમાઇન્ડર",
      "રિમાઇન્ડર",
      "રિમાઇન્ડર્સ",
      "आज की दवा",
      "आज की दवाएं",
      "आज की दवा सूची",
      "आज के रिमाइंडर",
      "रिमाइंडर",
      "रिमाइंडर्स",
    ];

    // Explicit keywords for Medication Refills & Stock
    const explicitRefillKeywords = [
      "refill",
      "refills",
      "stock",
      "remaining quantity",
      "remaing quntity",
      "remaining qty",
      "remaining",
      "remaing",
      "quantity left",
      "supply left",
      "pills left",
      "tablets left",
      "how many left",
      "running low",
      "low stock",
      "રિફિલ",
      "રીફીલ",
      "રિમફિલ",
      "જથ્થો",
      "બાકી જથ્થો",
      "સ્ટોક",
      "रिफिल",
      "स्टॉक",
      "मात्रा",
      "बची मात्रा",
    ];

    // Explicit keywords for Notifications
    const explicitNotifKeywords = [
      "notification",
      "notifications",
      "alert",
      "alerts",
      "push notice",
      "unread notification",
      "unread notifications",
      "notification list",
      "notifications list",
      "unread notification list",
      "unread alert",
      "unread alerts",
      "નોટિફિકેશન",
      "સંદેશ",
      "અલર્ટ",
      "ન વંચાયેલ",
      "ન વંચાયેલ નોટિફિકેશન",
      "नोटिफिकेशन",
      "अलर्ट",
      "सूचना",
      "अपठित",
      "अपठित नोटिफिकेशन",
    ];

    const isConversationalOrAdvice = hasAny(lowerQuestion, [
      "how to",
      "how can",
      "how should",
      "how do i take",
      "how to take",
      "why should",
      "why did",
      "why was",
      "why do i",
      "why is",
      "can i",
      "should i",
      "could i",
      "may i",
      "is it safe",
      "side effect",
      "side effects",
      "reaction",
      "interaction",
      "what should i",
      "what if",
      "advice",
      "advise",
      "suggest",
      "recommend",
      "explain",
      " versus ",
      " vs ",
      "કેવી રીતે લેવી",
      "શા માટે",
      "શું હું",
      "કેમ",
      "શકાય",
      "कैसे लेना",
      "क्यों",
      "क्या मैं",
      "सलाह",
    ]);

    const explicitCompareKeywords = keywordDictionary.COMPARE;
    const docListKeywords = keywordDictionary.DOCUMENT_LIST;
    const contentBiomarkerKeywords = keywordDictionary.DOCUMENT_CONTENT_BIOMARKER;

    const hasExplicitCompare =
      hasAny(lowerQuestion, explicitCompareKeywords) ||
      hasAny(cleanQuestion, explicitCompareKeywords);
    const hasSummary =
      hasAny(lowerQuestion, SUMMARY_KEYWORDS) || hasAny(cleanQuestion, SUMMARY_KEYWORDS);
    const hasContentSearch =
      hasAny(lowerQuestion, contentBiomarkerKeywords) ||
      hasAny(cleanQuestion, contentBiomarkerKeywords);

    const hasDocReference =
      (hasAny(lowerQuestion, keywordDictionary.DOCUMENT) &&
        !hasAny(lowerQuestion, explicitNotifKeywords) &&
        !hasAny(normalizedQuestion, explicitNotifKeywords) &&
        !hasAny(lowerQuestion, explicitReminderKeywords) &&
        !hasAny(normalizedQuestion, explicitReminderKeywords) &&
        !hasAny(lowerQuestion, explicitRefillKeywords) &&
        !hasAny(normalizedQuestion, explicitRefillKeywords)) ||
      hasContentSearch ||
      hasExplicitCompare ||
      hasSummary ||
      (ctx.documentId && ctx.documentId.length > 0);

    // Intercept 4: Medication Reminders & Today's Schedule Query
    const isReminderQuery =
      (hasAny(lowerQuestion, explicitReminderKeywords) ||
        hasAny(normalizedQuestion, explicitReminderKeywords) ||
        ((lowerQuestion.includes("today") || lowerQuestion.includes("schedule")) &&
          (hasAny(lowerQuestion, keywordDictionary.REMINDER) ||
            lowerQuestion.includes("medication") ||
            lowerQuestion.includes("medicine")))) &&
      !hasDocReference &&
      !isConversationalOrAdvice &&
      !hasAny(lowerQuestion, keywordDictionary.PROFILE_EXCLUSIONS);

    if (isReminderQuery) {
      return await this._handleReminderIntercept(ctx);
    }

    // Intercept 5: Medication Refills & Stock Query
    const isRefillQuery =
      (hasAny(lowerQuestion, explicitRefillKeywords) ||
        hasAny(normalizedQuestion, explicitRefillKeywords) ||
        ((lowerQuestion.includes("medication") || lowerQuestion.includes("medicine")) &&
          (lowerQuestion.includes("remaining") ||
            lowerQuestion.includes("remaing") ||
            lowerQuestion.includes("quantity") ||
            lowerQuestion.includes("quntity") ||
            lowerQuestion.includes("stock") ||
            lowerQuestion.includes("refill")))) &&
      !hasDocReference &&
      !isConversationalOrAdvice &&
      !hasAny(lowerQuestion, keywordDictionary.PROFILE_EXCLUSIONS);

    if (isRefillQuery) {
      return await this._handleRefillIntercept(ctx);
    }

    // Intercept 6: Notifications Query
    const isNotificationQuery =
      (hasAny(lowerQuestion, explicitNotifKeywords) ||
        hasAny(normalizedQuestion, explicitNotifKeywords) ||
        ((lowerQuestion.includes("notification") || lowerQuestion.includes("alert")) &&
          (lowerQuestion.includes("list") || lowerQuestion.includes("unread")))) &&
      !hasDocReference &&
      !isConversationalOrAdvice &&
      !hasAny(lowerQuestion, keywordDictionary.PROFILE_EXCLUSIONS);

    if (isNotificationQuery) {
      return await this._handleNotificationIntercept(ctx);
    }

    // Intercept 7: Medication List (ONLY explicit list requests return STRUCTURED_LIST with array and pagination)
    const isMedicationListRequest =
      hasAny(cleanQuestion, MEDICATION_LIST_KEYWORDS) ||
      hasAny(normalizedQuestion, MEDICATION_LIST_KEYWORDS) ||
      ((lowerQuestion.includes("medication") || lowerQuestion.includes("medicine")) &&
        (lowerQuestion.includes("list") || lowerQuestion.includes("liist")));

    if (isMedicationListRequest) {
      const allMeds = await medicationRepository.findAll(userId);
      const reqPage = ctx.page || 1;
      const reqLimit = ctx.limit || (allMeds.length > 0 ? allMeds.length : 20);
      const { data: pageMeds, page } = paginateArray(allMeds, { page: reqPage, limit: reqLimit });

      const structuredPayload = {
        items: pageMeds.map((m) => ({
          name: m.medicationName,
          dosage: m.dosePerIntake,
          frequency: m.frequency,
          schedule: m.medicationSchedule,
          startDate: toDbDateOnlyString(m.startDate),
          endDate: toDbDateOnlyString(m.endDate),
        })),
        pagination: page,
      };

      const { userMessage, aiMessage } = await this._saveExchange({
        userId,
        sessionId,
        question,
        content: JSON.stringify(structuredPayload),
        metadata: {
          mode: "STRUCTURED_LIST",
          task: "MEDICATION_LIST",
          emergency: false,
          documentId: [],
        },
        citations: [],
      });

      debugLogger.info("sendMessage: [MEDICATION LIST INTERCEPT]", {
        userId,
        question: cleanQuestion,
        totalMedications: page.totalRecords,
        pageNumber: page.pageNumber,
        totalPages: page.totalPages,
      });

      return {
        ai: aiMessage,
        user: userMessage,
        reply: structuredPayload,
        mode: "STRUCTURED_LIST",
        emergency: false,
      };
    }

    // Intercept 8: Document Catalog Listing (explicit list, status-wise list, or type-wise list)
    const hasListKeyword =
      hasAny(lowerQuestion, docListKeywords) || hasAny(cleanQuestion, docListKeywords);
    const statusFilter =
      detectDocumentStatusFilter(cleanQuestion) || detectDocumentStatusFilter(lowerQuestion);
    const typeFilter =
      detectDocumentTypeFilter(cleanQuestion) || detectDocumentTypeFilter(lowerQuestion);

    const genericDocKeywords = keywordDictionary.DOCUMENT;
    const hasDocKeyword =
      hasAny(lowerQuestion, genericDocKeywords) || hasAny(cleanQuestion, genericDocKeywords);

    const isMedicationRelated =
      isMedicationListRequest ||
      isReminderQuery ||
      isRefillQuery ||
      hasAny(lowerQuestion, explicitReminderKeywords) ||
      hasAny(normalizedQuestion, explicitReminderKeywords) ||
      hasAny(lowerQuestion, explicitRefillKeywords) ||
      hasAny(normalizedQuestion, explicitRefillKeywords) ||
      ((lowerQuestion.includes("medication") ||
        lowerQuestion.includes("medicine") ||
        lowerQuestion.includes("દવા") ||
        lowerQuestion.includes("दवा")) &&
        (lowerQuestion.includes("list") ||
          lowerQuestion.includes("liist") ||
          lowerQuestion.includes("today") ||
          lowerQuestion.includes("remaining") ||
          lowerQuestion.includes("remaing")));

    const isNotificationRelated =
      isNotificationQuery ||
      hasAny(lowerQuestion, explicitNotifKeywords) ||
      hasAny(normalizedQuestion, explicitNotifKeywords) ||
      ((lowerQuestion.includes("notification") ||
        lowerQuestion.includes("alert") ||
        lowerQuestion.includes("નોટિફિકેશન") ||
        lowerQuestion.includes("नोटिफिकेशन")) &&
        (lowerQuestion.includes("list") || lowerQuestion.includes("unread")));

    const isDocumentCatalogListing =
      (hasListKeyword || ((statusFilter || typeFilter) && (hasDocKeyword || hasListKeyword))) &&
      !hasContentSearch &&
      !hasExplicitCompare &&
      !hasSummary &&
      !isProfileQuestion(lowerQuestion) &&
      !isProfileQuestion(cleanQuestion) &&
      !isMedicationRelated &&
      !isNotificationRelated;

    if (isDocumentCatalogListing) {
      let allDocs = await documentRepository.getSummaryByUserId(userId);

      // Apply document type filter if detected
      if (typeFilter) {
        allDocs = allDocs.filter((d) => normalizeDocumentType(d.documentType) === typeFilter);
      }

      // Apply OCR status filter if detected
      if (statusFilter) {
        if (statusFilter === "FAILED" || statusFilter === "REJECTED") {
          allDocs = allDocs.filter((d) =>
            [ocrStatus.FAILED, ocrStatus.CANCELED].includes(
              String(d.ocrStatus || "").toLowerCase(),
            ),
          );
        } else if (statusFilter === "COMPLETED") {
          allDocs = allDocs.filter(
            (d) => String(d.ocrStatus || "").toLowerCase() === ocrStatus.COMPLETED,
          );
        } else if (statusFilter === "PENDING") {
          allDocs = allDocs.filter((d) =>
            [ocrStatus.PENDING, ocrStatus.IN_PROGRESS].includes(
              String(d.ocrStatus || "").toLowerCase(),
            ),
          );
        }
      }

      const reqPage = ctx.page || 1;
      const reqLimit = ctx.limit || (allDocs.length > 0 ? allDocs.length : 20);
      const { data: pageDocs, page } = paginateArray(allDocs, { page: reqPage, limit: reqLimit });

      const structuredPayload = {
        items: pageDocs.map((d) => {
          let formattedDate = null;
          if (d.reportDate) {
            formattedDate = toIsoDateOnly(d.reportDate);
          }
          return {
            id: d.id,
            fileName: d.fileName,
            documentType: d.documentType,
            fileType: d.fileType,
            reportDate: formattedDate,
            ...(d.ocrStatus ? { ocrStatus: d.ocrStatus } : {}),
          };
        }),
        pagination: page,
      };

      const { userMessage, aiMessage } = await this._saveExchange({
        userId,
        sessionId,
        question,
        content: JSON.stringify(structuredPayload),
        metadata: {
          mode: "STRUCTURED_LIST",
          task: "DOCUMENT_LIST",
          ...(typeFilter ? { typeFilter } : {}),
          ...(statusFilter ? { statusFilter } : {}),
          emergency: false,
          documentId: [],
        },
        citations: [],
      });

      debugLogger.info("sendMessage: [DOCUMENT LIST INTERCEPT]", {
        userId,
        question: cleanQuestion,
        typeFilter,
        statusFilter,
        totalDocuments: page.totalRecords,
        pageNumber: page.pageNumber,
        totalPages: page.totalPages,
      });

      return {
        ai: aiMessage,
        user: userMessage,
        reply: structuredPayload,
        mode: "STRUCTURED_LIST",
        emergency: false,
      };
    }

    return null;
  }

  async _handleProfileIntercept(ctx) {
    const {
      cleanQuestion,
      detectedLanguage,
      p,
      userId,
      sessionId,
      question,
      onChunk,
      abortSignal,
    } = ctx;
    const lowerQ = cleanQuestion.toLowerCase();
    const labels = pickLang(PROFILE_REPLY_I18N, detectedLanguage);

    const officialFullName =
      `${p?.firstName || ""} ${p?.lastName || ""}`.trim() ||
      p?.fullName ||
      p?.userName ||
      labels.unknown;

    const mobileStr = p?.mobile || "";
    const mobileDisplay = mobileStr || labels.none;
    const emailStr = p?.email || labels.none;
    const patientCodeStr = p?.patientCode || "N/A";
    const bloodGroupStr = p?.bloodGroup || labels.notSpecified;
    const allergiesStr =
      Array.isArray(p?.allergies) && p.allergies.length > 0 ? p.allergies.join(", ") : labels.none;
    const dobStr = p?.dateOfBirth ? toIsoDateOnly(p.dateOfBirth) : labels.notSpecified;
    const genderStr = p?.gender || labels.notSpecified;

    // Check login method (Mobile vs Social, and which social provider)
    let loginTypeDesc = "";
    let authProviders = [];
    if (userId) {
      try {
        authProviders = await authProviderRepository.findByUserId(userId);
      } catch (err) {
        debugLogger.warn("_handleProfileIntercept: Failed to query auth_providers", {
          error: err.message,
        });
      }
    }

    const SOCIAL_PROVIDER_NAMES = {
      google: "Google",
      facebook: "Facebook",
      apple: "Apple",
      microsoft: "Microsoft",
    };

    const socialRecords = Array.isArray(authProviders)
      ? authProviders.filter((ap) =>
          ["google", "facebook", "apple", "microsoft"].includes(ap.provider),
        )
      : [];
    const hasMobileRecord = Array.isArray(authProviders)
      ? authProviders.some((ap) => ap.provider === "mobile")
      : false;

    if (socialRecords.length > 0) {
      const socialNames = [
        ...new Set(socialRecords.map((s) => SOCIAL_PROVIDER_NAMES[s.provider] || s.provider)),
      ].join(", ");

      const isMobileAlso = hasMobileRecord || (mobileStr && p?.isMobileVerified);
      if (isMobileAlso) {
        loginTypeDesc = `Social Login (${socialNames}) & Mobile OTP (${mobileDisplay})`;
      } else {
        loginTypeDesc = `Social Login (${socialNames})`;
      }
    } else if (hasMobileRecord || mobileStr || p?.isMobileVerified) {
      if (p?.email && !p?.password) {
        loginTypeDesc = `Mobile OTP (${mobileDisplay}) & Email (${emailStr})`;
      } else {
        loginTypeDesc = `Mobile OTP (${mobileDisplay})`;
      }
    } else if (p?.firebaseUid) {
      if (p.firebaseUid.startsWith("microsoft_")) {
        loginTypeDesc = "Social Login (Microsoft)";
      } else if (p.firebaseUid.includes("google")) {
        loginTypeDesc = "Social Login (Google)";
      } else if (p.firebaseUid.includes("apple")) {
        loginTypeDesc = "Social Login (Apple)";
      } else if (p.firebaseUid.includes("facebook")) {
        loginTypeDesc = "Social Login (Facebook)";
      } else if (p?.email) {
        loginTypeDesc = `Social Login (${emailStr})`;
      } else {
        loginTypeDesc = "Mobile OTP";
      }
    } else if (p?.email && p?.password) {
      loginTypeDesc = `Email & Password (${emailStr})`;
    } else if (p?.email) {
      loginTypeDesc = `Social Login (${emailStr})`;
    } else {
      loginTypeDesc = "Standard Account";
    }

    let replyText = "";
    if (hasAny(lowerQ, ["age", "how old", "વય", "ઉંમર", "आयु", "उम्र", "वय", "வயது"])) {
      const ageTemplates = pickLang(AGE_REPLY_I18N, detectedLanguage);
      if (p && p.dateOfBirth) {
        const dobIso = toIsoDateOnly(p.dateOfBirth);
        const calculatedAge = getAgeFromDateOfBirth(p.dateOfBirth);
        replyText = ageTemplates.success(dobIso, calculatedAge);
      } else {
        replyText = ageTemplates.missing;
      }
    } else if (
      hasAny(lowerQ, [
        "my name",
        "what is my name",
        "who am i",
        "full name",
        "first name",
        "last name",
        "user name",
        "username",
        "મારું નામ",
        "મારું નામ શું છે",
        "હું કોણ છું",
        "मेरा नाम",
        "मेरा नाम क्या है",
        "मैं कौन हूँ",
        "माझे नाव",
        "என் பெயர்",
      ])
    ) {
      replyText = labels.specificName(officialFullName);
    } else if (
      hasAny(lowerQ, [
        "blood",
        "blood group",
        "blood type",
        "બ્લડ ગ્રુપ",
        "ब्लड ग्रुप",
        "रक्तगट",
        "இரத்த வகை",
      ])
    ) {
      replyText = labels.specificBloodGroup(bloodGroupStr);
    } else if (hasAny(lowerQ, ["allergy", "allergies", "એલર્જી", "एलर्जी", "ऍલર્જી", "ஒவ்வாமை"])) {
      replyText = labels.specificAllergies(allergiesStr);
    } else if (
      hasAny(lowerQ, [
        "my email",
        "what is my email",
        "email address",
        "ઇમેઇલ",
        "ઈમેલ",
        "ईमेल",
        "மின்னஞ்சல்",
      ])
    ) {
      replyText = labels.specificEmail(emailStr);
    } else if (
      hasAny(lowerQ, [
        "my mobile",
        "my phone",
        "phone number",
        "mobile number",
        "મોબાઇલ",
        "मोबाइल",
        "மொபைல்",
      ])
    ) {
      replyText = labels.specificMobile(mobileDisplay);
    } else if (
      hasAny(lowerQ, [
        "patient code",
        "user code",
        "my code",
        "પેશન્ટ કોડ",
        "દર્દી કોડ",
        "पेशेंट कोड",
        "रुग्ण कोड",
        "நோயாளி குறியீடு",
      ])
    ) {
      replyText =
        typeof labels.specificPatientCode === "function"
          ? labels.specificPatientCode(patientCodeStr)
          : `Your patient code is ${patientCodeStr}.`;
    } else if (
      hasAny(lowerQ, [
        "login method",
        "login type",
        "how did i log in",
        "how did i login",
        "how i logged in",
        "login mode",
        "login style",
        "logged in with",
        "logged in via",
        "mobile or social",
        "social or mobile",
        "social login",
        "which login",
        "is it mobile",
        "is it social",
        "લોગિન રીત",
        "કેવી રીતે લોગિન કર્યું",
        "સોશિયલ લોગિન",
        "મોબાઇલ કે સોશિયલ",
        "લૉગિન પદ્ધતિ",
        "लॉगिन का प्रकार",
        "कैसे लॉगिन किया",
        "सोशल लॉगिन",
        "लॉगिन पद्धत",
        "லாகின் முறை",
      ])
    ) {
      replyText = labels.specificLoginMethod(loginTypeDesc);
    } else {
      replyText =
        `**${labels.title}**\n` +
        `- **${labels.name}:** ${officialFullName}\n` +
        `- **${labels.email}:** ${emailStr}\n` +
        `- **${labels.mobile}:** ${mobileDisplay}\n` +
        `- **${labels.dob}:** ${dobStr}\n` +
        `- **${labels.gender}:** ${genderStr}\n` +
        `- **${labels.bloodGroup}:** ${bloodGroupStr}\n` +
        `- **${labels.allergies}:** ${allergiesStr}\n` +
        `- **${labels.loginMethod}:** ${loginTypeDesc}`;
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "PROFILE_DIRECT",
        emergency: false,
        documentId: [],
        profile: {
          name: officialFullName,
          email: emailStr,
          mobile: mobileDisplay,
          dob: dobStr,
          gender: genderStr,
          bloodGroup: bloodGroupStr,
          allergies: allergiesStr,
          loginMethod: loginTypeDesc,
        },
      },
      citations: [],
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  async _handleReminderIntercept(ctx) {
    const { detectedLanguage, userId, sessionId, question, onChunk, abortSignal } = ctx;
    const labels = pickLang(REMINDER_REPLY_I18N, detectedLanguage);

    const occurrences = occurrenceRepository.findTodayOccurrences
      ? await occurrenceRepository.findTodayOccurrences(userId)
      : occurrenceRepository.findAllOccurrences
        ? await occurrenceRepository.findAllOccurrences(userId)
        : [];

    let replyText = "";
    let savedReminders = occurrences || [];
    if (!occurrences || occurrences.length === 0) {
      let activeMeds = [];
      try {
        const allMeds = await medicationRepository.findAll(userId);
        const todayStr = new Date().toISOString().split("T")[0];
        activeMeds = (allMeds || []).filter((m) => {
          if (m.ongoing) return true;
          const startStr = m.startDate ? new Date(m.startDate).toISOString().split("T")[0] : null;
          const endStr = m.endDate ? new Date(m.endDate).toISOString().split("T")[0] : null;
          if (startStr && startStr > todayStr) return false;
          if (endStr && endStr < todayStr) return false;
          return true;
        });
      } catch (medErr) {
        debugLogger.error("_handleReminderIntercept: Failed to query active meds", {
          error: medErr.message,
        });
      }

      if (activeMeds.length > 0) {
        savedReminders = activeMeds;
        const medLines = activeMeds.map((m, idx) => {
          const name = m.medicationName || "Medicine";
          const dose = m.dosePerIntake ? `${m.dosePerIntake} ${m.unit || ""}`.trim() : "";
          const freq = m.frequency ? `, ${m.frequency}` : "";
          const sched = m.medicationSchedule
            ? ` (${Array.isArray(m.medicationSchedule) ? m.medicationSchedule.join(", ") : JSON.stringify(m.medicationSchedule)})`
            : "";
          return `${idx + 1}. **${name}**${dose ? `: ${dose}` : ""}${freq}${sched}`;
        });
        replyText =
          `**${labels.title}**\n` +
          `- **${labels.total}:** ${activeMeds.length}\n\n` +
          medLines.join("\n");
      } else {
        replyText = labels.noReminders;
      }
    } else {
      const takenCount = occurrences.filter((o) => o.status === "TAKEN").length;
      const missedCount = occurrences.filter((o) => o.status === "MISSED").length;
      const pendingCount = occurrences.filter((o) => o.status === "PENDING" || !o.status).length;

      const scheduleLines = occurrences.map((o, idx) => {
        let timeStr = "Scheduled Time";
        if (o.actualMedicationTime) {
          try {
            timeStr = new Date(o.actualMedicationTime).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
          } catch {
            timeStr = String(o.actualMedicationTime);
          }
        }
        const medName = o.medicationName || "Medicine";
        const status = o.status || "PENDING";
        return `${idx + 1}. **${medName}** at ${timeStr} - [${status}]`;
      });

      replyText =
        `**${labels.title}**\n` +
        `- **${labels.total}:** ${occurrences.length}\n` +
        `- **${labels.taken}:** ${takenCount}\n` +
        `- **${labels.pending}:** ${pendingCount}\n` +
        `- **${labels.missed}:** ${missedCount}\n\n` +
        scheduleLines.join("\n");
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "REMINDER_STATUS",
        emergency: false,
        documentId: [],
        reminders: savedReminders,
      },
      citations: [],
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  async _handleRefillIntercept(ctx) {
    const { detectedLanguage, userId, sessionId, question, onChunk, abortSignal } = ctx;
    const labels = pickLang(REFILL_REPLY_I18N, detectedLanguage);

    const allMeds = await medicationRepository.findAll(userId);
    let replyText = "";
    let processedMeds = allMeds || [];

    if (!allMeds || allMeds.length === 0) {
      replyText = labels.noMeds;
    } else {
      processedMeds = await Promise.all(
        allMeds.map(async (m) => {
          let remaining = m.remainingQuantity;
          if (remaining === undefined || remaining === null) {
            try {
              remaining = await calculateRemainingQuantity(m);
            } catch {
              remaining = m.totalQuantity ?? 0;
            }
          }
          return { ...m, remainingQuantity: remaining };
        }),
      );

      const lowStockMeds = processedMeds.filter((m) => {
        const hasLowRemaining =
          m.remainingQuantity !== null &&
          m.remainingQuantity !== undefined &&
          m.refillWarningThreshold !== null &&
          m.refillWarningThreshold !== undefined
            ? Number(m.remainingQuantity) <= Number(m.refillWarningThreshold)
            : Number(m.remainingQuantity) <= 5;
        const hasLowRefills =
          m.refillCount !== null && m.refillCount !== undefined && Number(m.refillCount) <= 1;
        return hasLowRemaining || hasLowRefills;
      });

      const medLines = processedMeds.map((m, idx) => {
        const name = m.medicationName || "Medicine";
        const remaining = m.remainingQuantity ?? m.totalQuantity ?? "N/A";
        const refills = m.refillCount ?? "N/A";
        const unit = m.unit ? ` ${m.unit}` : "";
        return `${idx + 1}. **${name}**: ${labels.remainingStock} = ${remaining}${unit}, ${labels.refillsLeft} = ${refills}`;
      });

      if (lowStockMeds.length > 0) {
        const warningLines = lowStockMeds.map(
          (m) => `- ⚠️ **${m.medicationName}**: ${m.remainingQuantity ?? 0} remaining`,
        );
        replyText =
          `**${labels.title}**\n\n` +
          `**${labels.lowStock}**\n` +
          warningLines.join("\n") +
          `\n\n` +
          medLines.join("\n");
      } else {
        replyText = `**${labels.title}**\n` + `${labels.sufficientStock}\n\n` + medLines.join("\n");
      }
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "REFILL_STATUS",
        emergency: false,
        documentId: [],
        medications: processedMeds,
      },
      citations: [],
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  async _handleNotificationIntercept(ctx) {
    const { detectedLanguage, userId, sessionId, question, onChunk, abortSignal, retrievalQuery } =
      ctx;
    const labels = pickLang(NOTIFICATION_REPLY_I18N, detectedLanguage);
    const lowerQ = String(retrievalQuery || question || "").toLowerCase();

    const notifResult = notificationRepository.list
      ? await notificationRepository.list({ userId, sort: { orderBy: "desc" } })
      : [];
    const notifs = Array.isArray(notifResult) ? notifResult : notifResult?.items || [];

    let replyText = "";
    if (!notifs || notifs.length === 0) {
      replyText = labels.noNotifs;
    } else {
      const unreadCount = notifs.filter((n) => !n.isRead).length;
      const readCount = notifs.filter((n) => n.isRead).length;

      const isUnreadQuery =
        lowerQ.includes("unread") ||
        lowerQ.includes("ન વંચાયેલ") ||
        lowerQ.includes("अपठित") ||
        lowerQ.includes("न वाचलेले");

      const displayNotifs = isUnreadQuery ? notifs.filter((n) => !n.isRead) : notifs;

      if (isUnreadQuery && displayNotifs.length === 0) {
        const noUnreadMsg =
          detectedLanguage === "gujarati"
            ? "તમારી પાસે કોઈ ન વંચાયેલ નોટિફિકેશન નથી."
            : detectedLanguage === "hindi"
              ? "आपकी कोई अपठित सूचना नहीं है।"
              : "You have no unread notifications.";

        replyText =
          `**${labels.title}**\n` +
          `- **${labels.total}:** ${notifs.length}\n` +
          `- **${labels.unread}:** 0\n` +
          `- **${labels.read}:** ${readCount}\n\n` +
          noUnreadMsg;
      } else {
        const topNotifs = displayNotifs.slice(0, 5).map((n, idx) => {
          const title = n.title || "Notification";
          const status = n.isRead ? "Read" : "Unread";
          const message = n.body || n.message || "";
          return `${idx + 1}. [${status}] **${title}**: ${message}`;
        });

        replyText =
          `**${labels.title}**\n` +
          `- **${labels.total}:** ${notifs.length}\n` +
          `- **${labels.unread}:** ${unreadCount}\n` +
          `- **${labels.read}:** ${readCount}\n\n` +
          topNotifs.join("\n");
      }
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "NOTIFICATION_STATUS",
        emergency: false,
        documentId: [],
        notifications: notifs,
      },
      citations: [],
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  _analyzeIntent(ctx) {
    let intent = "GENERAL";
    let documentScope = "NONE";
    const intentStartTime = Date.now();

    const lowerQuestion = ctx.retrievalQuery.toLowerCase();

    const documentKeywords = keywordDictionary.DOCUMENT;
    const fullDocKeywords = keywordDictionary.DOCUMENT_FULL;
    const explicitCompareKeywords = keywordDictionary.COMPARE;
    const allScopeKeywords = keywordDictionary.ALL_SCOPE;

    const hasExplicitCompare = hasAny(lowerQuestion, explicitCompareKeywords);
    const hasSummary = hasAny(lowerQuestion, SUMMARY_KEYWORDS);
    const hasAllScope = hasAny(lowerQuestion, allScopeKeywords);
    const hasDocument = hasAny(lowerQuestion, documentKeywords);
    const hasFullDoc = hasAny(lowerQuestion, fullDocKeywords);

    let intentReason = "DEFAULT";
    const isProfile = isProfileQuestion(ctx.retrievalQuery);

    if (isProfile) {
      intent = "GENERAL";
      documentScope = "NONE";
      intentReason = "USER_PROFILE_QUERY";
    } else if (ctx.documentId && ctx.documentId.length > 0) {
      intent = ctx.documentId.length > 1 ? "COMPARE" : "DOCUMENT";
      documentScope = ctx.documentId.length > 1 ? "SELECTED_MULTI_DOCUMENT" : "SINGLE_DOCUMENT";
      intentReason =
        ctx.documentId.length > 1 ? "EXPLICIT_DOCUMENT_IDS_MULTI" : "EXPLICIT_DOCUMENT_ID_SINGLE";
      if (hasFullDoc) documentScope = "FULL_DOCUMENT";
    } else {
      // High-priority rule: ALL-DOCUMENTS summary/overview query without explicit compare intent
      if (hasSummary && (hasAllScope || hasDocument) && !hasExplicitCompare) {
        intent = "DOCUMENT";
        documentScope = "ALL_DOCUMENTS";
        intentReason = "ALL_DOCUMENTS_SUMMARY_OVERVIEW";
      } else if (hasExplicitCompare && (hasDocument || hasAllScope)) {
        intent = "COMPARE";
        documentScope = "ALL_DOCUMENTS";
        intentReason = "EXPLICIT_COMPARE_QUERY";
      } else if (hasExplicitCompare) {
        intent = "COMPARE";
        documentScope = "ALL_DOCUMENTS";
        intentReason = "EXPLICIT_COMPARE_KEYWORD";
      } else if (hasDocument || hasAllScope) {
        intent = "DOCUMENT";
        documentScope = "ALL_DOCUMENTS";
        intentReason = "DOCUMENT_QUERY";
      } else {
        intent = "GENERAL";
        documentScope = "NONE";
        intentReason = "GENERAL_HEALTH_QUERY";
      }

      if (hasFullDoc && intent !== "GENERAL") {
        documentScope = "FULL_DOCUMENT";
      }
    }

    debugLogger.info(
      `sendMessage: [INTENT ANALYZER & DOMAIN DEBUG] ${JSON.stringify({
        query: ctx.retrievalQuery,
        isProfile,
        intent,
        documentScope,
        reason: intentReason,
        detectedLanguage: ctx.detectedLanguage,
        durationMs: Date.now() - intentStartTime,
      })}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[DEBUG DOMAIN & INTENT] Query: "${ctx.retrievalQuery}" | isProfile: ${isProfile} | Intent: ${intent} | documentScope: ${documentScope} | Reason: ${intentReason}`,
    );

    ctx.intent = intent;
    ctx.documentScope = documentScope;
    ctx.intentReason = intentReason;
    ctx.isProfile = isProfile;
  }

  async _resolveDocuments(ctx) {
    let {
      intent,
      documentScope,
      documentId,
      retrievalQuery,
      detectedLanguage,
      userId,
      sessionId,
      question,
    } = ctx;

    let finalDocumentIds = [];
    if (intent === "DOCUMENT" || intent === "COMPARE") {
      if (documentId && documentId.length > 0) {
        finalDocumentIds = documentId;
      } else {
        const recentDocs = await db
          .select({
            id: document.id,
            fileName: document.fileName,
            documentType: document.documentType,
            reportDate: document.reportDate,
            createdAt: document.createdAt,
          })
          .from(document)
          .where(eq(document.userId, userId))
          .orderBy(desc(document.createdAt));

        if (recentDocs.length === 0) {
          intent = "GENERAL";
          documentScope = "NONE";
        } else if (
          documentScope === "ALL_DOCUMENTS" ||
          documentScope === "FULL_DOCUMENT" ||
          documentScope === "COMPARE"
        ) {
          // Check if user is asking for selection vs specific reports
          const explicitCompareKeywords = keywordDictionary.COMPARE;
          const documentKeywords = keywordDictionary.DOCUMENT;
          if (
            intent === "COMPARE" &&
            !retrievalQuery
              .toLowerCase()
              .replace(/[^a-z0-9]/g, " ")
              .split(/\\s+/)
              .filter((w) => w.length > 0)
              .some(
                (w) =>
                  !explicitCompareKeywords.includes(w) &&
                  !documentKeywords.includes(w) &&
                  ![
                    "can",
                    "you",
                    "please",
                    "and",
                    "or",
                    "show",
                    "give",
                    "me",
                    "between",
                    "these",
                    "those",
                    "results",
                    "result",
                    "of",
                    "in",
                    "from",
                    "for",
                    "with",
                    "a",
                    "an",
                    "is",
                    "are",
                    "was",
                    "were",
                    "to",
                    "do",
                    "does",
                    "did",
                    "have",
                    "has",
                    "had",
                  ].includes(w),
              )
          ) {
            const replyText = pickLang(REQUIRE_SELECTION_I18N, detectedLanguage);
            const { userMessage: userMsg, aiMessage: aiMsg } = await this._saveExchange({
              userId,
              sessionId,
              question,
              content: replyText,
              metadata: {
                mode: "DOCUMENT_RAG",
                emergency: false,
                requireSelection: true,
                documentId: [],
                reports: recentDocs,
              },
              citations: [],
            });
            return {
              interceptedResult: {
                ai: aiMsg,
                user: userMsg,
                reply: replyText,
                requireSelection: true,
                reports: recentDocs,
                mode: "DOCUMENT_RAG",
                emergency: false,
              },
            };
          }
          finalDocumentIds = recentDocs.map((d) => d.id);
        } else if (recentDocs.length === 1) {
          finalDocumentIds = [recentDocs[0].id];
          documentScope = "SINGLE_DOCUMENT";
        } else {
          // Intent is DOCUMENT, trying to find which one
          const lowerQuestion = retrievalQuery.toLowerCase();
          if (lowerQuestion.includes("first") || lowerQuestion.includes("oldest")) {
            finalDocumentIds = [recentDocs[recentDocs.length - 1].id];
          } else if (
            lowerQuestion.includes("last") ||
            lowerQuestion.includes("latest") ||
            lowerQuestion.includes("recent")
          ) {
            finalDocumentIds = [recentDocs[0].id];
          } else {
            const matchedDocs = recentDocs.filter((d) => {
              if (d.fileName) {
                const cleanName = d.fileName.toLowerCase().replace(".pdf", "").trim();
                if (
                  !["report", "reports", "document", "documents", "file", "files"].includes(
                    cleanName,
                  )
                ) {
                  if (lowerQuestion.includes(cleanName)) return true;
                }
              }
              return false;
            });
            if (matchedDocs.length > 0) {
              finalDocumentIds = matchedDocs.map((d) => d.id);
            } else {
              finalDocumentIds = recentDocs.map((d) => d.id);
              documentScope = "ALL_DOCUMENTS";
            }
          }
        }
      }
    }

    const docNameMap = {};
    if (finalDocumentIds && finalDocumentIds.length > 0) {
      const finalDocsMetadata = await db
        .select({
          id: document.id,
          fileName: document.fileName,
          reportDate: document.reportDate,
          documentType: document.documentType,
          structuredExtractedData: document.structuredExtractedData,
        })
        .from(document)
        .where(inArray(document.id, finalDocumentIds));
      finalDocsMetadata.forEach((d) => {
        docNameMap[d.id] = d;
      });
    }

    ctx.intent = intent;
    ctx.documentScope = documentScope;
    ctx.finalDocumentIds = finalDocumentIds;
    ctx.docNameMap = docNameMap;
    return {};
  }

  async _buildHistoryAndContext(ctx) {
    const { question, sessionId, userId, detectedLanguage, p, isProfile } = ctx;

    const userMessage = await chatSessionRepository.appendMessage({
      content: question.trim(),
      role: "user",
      sessionId,
      userId,
    });

    // HISTORY: Keep recent history even if documentId is passed to support follow-up questions
    const recent = await chatSessionRepository.listMessages({
      direction: "before",
      limit: 4,
      sessionId,
      userId,
    });
    const items = recent && Array.isArray(recent.items) ? recent.items : [];
    const history = items.map((msg) => ({ content: msg.content, role: msg.role }));

    // Prevent small models (like medgemma:4b) from mimicking previous message languages
    // by injecting a strong reminder into the very last user message.
    if (history.length > 0 && history[history.length - 1].role === "user") {
      history[history.length - 1].content +=
        `\n\n[SYSTEM REMINDER: You MUST answer strictly in ${detectedLanguage.toUpperCase()} ONLY, regardless of the language used in previous messages.]`;
    }

    // Build dependency-aware universal context (Profile, Medications, Refills, Reminders, Documents, Notifications)
    let patientContextStr = "";
    try {
      patientContextStr = await buildDependencyAwareContext(userId, question, { patient: p });
    } catch (err) {
      debugLogger.error("sendMessage: Failed to build dependency-aware app context", {
        error: err.message,
      });
    }

    if (patientContextStr) {
      patientContextStr += `\n\nIMPORTANT INSTRUCTION: Use the above patient profile, active medications, refill counts, reminder schedules, document catalog, and notification information ONLY to answer the user's specific question.`;
      if (isProfile) {
        patientContextStr += `\n\nCRITICAL PROFILE INSTRUCTION: The user is asking about their official logged-in account profile. You MUST answer using ONLY the database user profile details in === OFFICIAL LOGGED-IN USER PROFILE & AUTHENTICATION (DATABASE) ===. NEVER state or substitute patient names, ages, or details printed on uploaded medical reports.`;
      }
    }

    ctx.userMessage = userMessage;
    ctx.history = history;
    ctx.patientContextStr = patientContextStr;
  }

  async _generateAnswer(ctx) {
    const {
      intent,
      history,
      patientContextStr,
      detectedLanguage,
      onChunk,
      abortSignal,
      userId,
      retrievalQuery,
      finalDocumentIds,
      documentScope,
      docNameMap,
    } = ctx;

    let assistantText = NO_CONTEXT_REPLY;
    let isEmergency = false;
    let mode = intent === "GENERAL" ? "GENERAL_HEALTH" : "DOCUMENT_RAG";

    if (intent === "GENERAL") {
      try {
        debugLogger.info("sendMessage: [LLM TRACKING] [4] Calling Final Chat for GENERAL (Qwen)");

        const qwenStartTime = Date.now();
        const aiResponse = await this.qwenHealthChat(
          history,
          "GENERAL_HEALTH",
          [],
          patientContextStr,
          detectedLanguage,
          "",
          onChunk,
          abortSignal,
        );
        debugLogger.info(
          `sendMessage: [PERFORMANCE] Qwen LLM Generation (${env.chatModel}) took ${Date.now() - qwenStartTime}ms`,
        );
        assistantText = aiResponse.answer;
        isEmergency = !!aiResponse.emergency;
      } catch (llmErr) {
        debugLogger.error("sendMessage: LLM Generation failed for GENERAL intent", {
          error: llmErr.message,
          stack: llmErr.stack,
        });
        // eslint-disable-next-line no-console
        console.error(`[ChatService] LLM Generation failed for GENERAL: ${llmErr.message}`);
        assistantText =
          detectedLanguage === "english"
            ? "Sorry, I am currently unable to process your request."
            : "Please try again later.";
      }
    } else {
      // DATA RETRIEVER (Vector Search via RagContextService)
      let summaryChunks = [];
      let coverageStr = "";
      try {
        const queryEmbedding = await embeddingService.embedText(retrievalQuery);
        const ragResult = await ragContextService.retrieveRagContext({
          userId,
          retrievalQuery,
          queryEmbedding,
          finalDocumentIds,
          documentScope,
          docNameMap,
          detectedLanguage,
          intent,
        });
        summaryChunks = ragResult.summaryChunks;
        coverageStr = ragResult.coverageStr;
      } catch (err) {
        debugLogger.error("sendMessage: Failed to fetch chunks via vector search", {
          error: err.message,
        });
      }

      if (!summaryChunks.length) {
        assistantText = pickLang(NO_CONTEXT_REPLY_I18N, detectedLanguage);
      } else {
        try {
          debugLogger.info(
            "sendMessage: [LLM TRACKING] [4] Calling Final Chat for DOCUMENT_RAG (Qwen)",
          );

          const qwenStartTime = Date.now();
          const aiResponse = await this.qwenHealthChat(
            history,
            "DOCUMENT_RAG",
            summaryChunks,
            patientContextStr,
            detectedLanguage,
            coverageStr,
            onChunk,
            abortSignal,
          );
          debugLogger.info(
            `sendMessage: [QWEN] ${JSON.stringify({ model: env.chatModel, language: detectedLanguage, contextChunks: summaryChunks.length, generationDuration: Date.now() - qwenStartTime })}`,
          );
          assistantText = aiResponse.answer;
          isEmergency = !!aiResponse.emergency;
        } catch (ragErr) {
          debugLogger.error("sendMessage: LLM Generation failed for DOCUMENT_RAG intent", {
            error: ragErr.message,
            stack: ragErr.stack,
          });
          // eslint-disable-next-line no-console
          console.error(`[ChatService] LLM Generation failed for DOCUMENT_RAG: ${ragErr.message}`);
          assistantText = pickLang(NO_CONTEXT_REPLY_I18N, detectedLanguage);
        }
      }
    }

    ctx.assistantText = assistantText;
    ctx.isEmergency = isEmergency;
    ctx.mode = mode;
  }

  async _saveAndReturn(ctx) {
    const {
      assistantText,
      mode,
      isEmergency,
      finalDocumentIds,
      intent,
      sessionId,
      userId,
      _reqStartTime,
      userMessage,
    } = ctx;

    const aiMessage = await chatSessionRepository.appendMessage({
      citations: [],
      content: assistantText,
      metadata: {
        mode,
        emergency: isEmergency,
        documentId: finalDocumentIds || [],
        task: intent,
      },
      role: "assistant",
      sessionId,
      userId,
    });

    debugLogger.info("sendMessage: Total request execution time", {
      durationSec: ((Date.now() - _reqStartTime) / 1000).toFixed(2),
    });

    return {
      ai: aiMessage,
      citations: [],
      reply: assistantText,
      user: userMessage,
      mode,
      emergency: isEmergency,
    };
  }

  async sendMessage({
    userId,
    documentId,
    question,
    sessionId: reqSessionId,
    preferredLanguage: passedLang,
    page,
    limit,
    onChunk,
    abortSignal,
  }) {
    if (reqSessionId) {
      if (processingSessions.has(reqSessionId)) {
        throw new InvalidRequestException(
          "A message is already being processed for this session. Please wait.",
        );
      }
      processingSessions.add(reqSessionId);
    }

    try {
      // Normalize documentId to array
      if (documentId && !Array.isArray(documentId)) {
        documentId = [documentId];
      }

      const _reqStartTime = Date.now();

      debugLogger.info("sendMessage: Incoming payload", {
        userId,
        documentId,
        reqSessionId,
        question: question?.substring(0, 100),
      });

      const ctx = {
        userId,
        documentId,
        question,
        reqSessionId,
        passedLang,
        page: page ? Number(page) : null,
        limit: limit ? Number(limit) : null,
        onChunk,
        abortSignal,
        _reqStartTime,
      };

      await this._resolveQuestion(ctx);
      await this._resolveLanguage(ctx);
      await this._resolveSession(ctx);

      const interceptedResult = await this._tryIntercepts(ctx);
      if (interceptedResult) {
        return interceptedResult;
      }

      this._analyzeIntent(ctx);

      const docResolution = await this._resolveDocuments(ctx);
      if (docResolution.interceptedResult) {
        return docResolution.interceptedResult;
      }

      await this._buildHistoryAndContext(ctx);
      await this._generateAnswer(ctx);
      return await this._saveAndReturn(ctx);
    } finally {
      if (reqSessionId) processingSessions.delete(reqSessionId);
    }
  }

  async deleteSession({ sessionId, userId }) {
    const updated = await chatSessionRepository.softDeleteSession(sessionId, userId);
    if (!updated) throw new NotFoundException("Chat session not found");
    return updated;
  }

  //creat onboring session
  async createOnboardingSession({ userId, title = "Health Onboarding", metadata = {} }) {
    return chatSessionRepository.createSession({
      userId,
      documentId: null,
      title,
      lastMessageAt: new Date(),
      metadata,
    });
  }

  //appted chat messages
  async appendChatMessage({ sessionId, userId, role, content, citations = [], metadata = {} }) {
    return chatSessionRepository.appendMessage({
      sessionId,
      userId,
      role,
      content,
      citations,
      metadata,
    });
  }

  //update document id
  async attachDocumentToSession({ sessionId, userId, documentId }) {
    return chatSessionRepository.attachDocument(sessionId, userId, documentId);
  }
}

const chatService = new ChatService();

module.exports = {
  chatService,
  triageService,
  ragContextService,
  EMERGENCY_WARNING_I18N,
  getMedicalEntityKeywords,
  getReportAgeString,
};
