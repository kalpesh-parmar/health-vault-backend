const { env } = require("../../../configs/env");
const { messageConstants } = require("../../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../../exceptions/appError");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { eq, desc, inArray, and } = require("drizzle-orm");
const { ocrStatus } = require("../../../enums/ocrStatus");
const { ollamaClient } = require("../../../clients/ollamaClient");
const { embeddingService } = require("./embedding.service");
const prompts = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");

const aiClient = require("../clients/aiClient.service");
const { getAgeFromDateOfBirth } = require("../../../helpers/dateHelper");
const { normalizeLanguage } = require("../../../utils/commonUtils");
const { containsEntity } = require("../../../utils/synonyms");
const { toDbDateOnlyString } = require("../../../utils/dateUtils");
const { triageService, EMERGENCY_WARNING_I18N } = require("./triage.service");
const {
  ragContextService,
  buildMedicationsContext,
  getMedicalEntityKeywords,
  getReportAgeString,
  buildDependencyAwareContext,
} = require("./ragContext.service");
const { chatClassifier } = require("./chatClassifier.service");
const { slotContextService } = require("./slotContext.service");
const { medicalTrendChartService } = require("../../medicalTrendChart.service");
const { medicalFactLookupService } = require("../../medicalFactLookup.service");
const { patientLabResultRepository } = require("../../../repositories/patientLabResultRepository");
const { medicalFactValidatorService } = require("../../medicalFactValidator.service");
const {
  NO_CONTEXT_REPLY_I18N,
  REQUIRE_SELECTION_REPORT_I18N,
  AGE_REPLY_I18N,
  AGE_KEYWORDS,
  SUMMARY_KEYWORDS,
  SUMMARY_LABELS_I18N,
  REPORT_PROCESSING_I18N,
  DOCUMENT_STILL_PROCESSING_I18N,
  DOCUMENT_UNAVAILABLE_I18N,
  NO_REPORT_FOUND_I18N,
  NO_SUMMARY_AVAILABLE_I18N,
  PREDEFINED_QUESTIONS_I18N,
} = require("../../../constants/chatReplies");

const { chatFastPath } = require("./chatFastPath.service");
const { documentAuthorizationService } = require("./documentAuthorization.service");
const { documentResolverService } = require("./documentResolver.service");

// Debug logger
const debugLogger = {
  // eslint-disable-next-line no-console
  info: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
  // eslint-disable-next-line no-console
  error: (msg, data) => console.error(`[DEBUG ERROR] ${msg}`, JSON.stringify(data, null, 2)),
};

function xmlEscape(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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

const processingSessions = new Set();

class ChatService {
  detectEmergency(text) {
    return triageService.detectEmergency(text);
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
    structuredRecords = [],
  ) {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const userQuery = lastUserMessage?.content || "";
    const normLang = normalizeLanguage(preferredLanguage);

    if (this.detectEmergency(userQuery)) {
      return {
        answer: EMERGENCY_WARNING_I18N[normLang] || EMERGENCY_WARNING_I18N.english,
        mode,
        emergency: true,
        citations: [],
      };
    }

    if (mode === "DOCUMENT_RAG") {
      const defaultNoContext = NO_CONTEXT_REPLY_I18N[normLang] || NO_CONTEXT_REPLY_I18N.english;
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

      const xmlDelimitedReports = Array.from(chunksByDoc.entries())
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

          // Extract structured medical image observations if present
          let imageAnalysisStr = "";
          let structData = docData.structuredExtractedData;
          if (typeof structData === "string") {
            try {
              structData = JSON.parse(structData);
            } catch {
              // Empty Block
            }
          }
          const imgAnalysis = structData?.imageAnalysis;
          if (imgAnalysis) {
            const anat = imgAnalysis.anatomicalRegion || "";
            const view = imgAnalysis.suggestedView || "";
            const qual = imgAnalysis.imageQuality || "";
            const vis =
              imgAnalysis.visibleDetails ||
              (Array.isArray(imgAnalysis.visibleStructures)
                ? imgAnalysis.visibleStructures.join("; ")
                : "") ||
              "";
            const unc = imgAnalysis.uncertainty || "";
            const summ =
              imgAnalysis.aiGeneratedDescription || imgAnalysis.educationalDescription || "";
            imageAnalysisStr = `<imaging_observations modality="${xmlEscape(imgAnalysis.modality || "x_ray")}">
${anat ? `<anatomical_region>${xmlEscape(anat)}</anatomical_region>\n` : ""}${view ? `<suggested_view>${xmlEscape(view)}</suggested_view>\n` : ""}${qual ? `<image_quality>${xmlEscape(qual)}</image_quality>\n` : ""}${vis ? `<visible_structures>${xmlEscape(String(vis))}</visible_structures>\n` : ""}${unc ? `<technical_uncertainty>${xmlEscape(String(unc))}</technical_uncertainty>\n` : ""}${summ ? `<preliminary_summary>${xmlEscape(String(summ))}</preliminary_summary>\n` : ""}<review_status>PENDING_CLINICIAN_REVIEW (Preliminary AI visual screening; formal diagnosis requires licensed radiologist / physician review)</review_status>
</imaging_observations>\n`;
          }

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
              structuredTestsStr = relevantTests
                .map(
                  (t) =>
                    `<test name="${xmlEscape(t.name)}" value="${xmlEscape(t.value)}" unit="${xmlEscape(t.unit || "")}" status="${xmlEscape(t.status || "NORMAL")}" />`,
                )
                .join("\n");
            }
          }

          const chunksContent = chunks
            .map(
              (c) =>
                `<section title="${xmlEscape(c.sectionTitle || "General")}">\n${c.content}\n</section>`,
            )
            .join("\n");

          return `<medical_record filename="${xmlEscape(fileName)}" report_date="${xmlEscape(reportDate)}" patient="${xmlEscape(pName)}">
${imageAnalysisStr}${structuredTestsStr ? `<verified_tests>\n${structuredTestsStr}\n</verified_tests>\n` : ""}<clinical_evidence>
${chunksContent}
</clinical_evidence>
</medical_record>`;
        })
        .join("\n\n");

      const contextText = `<medical_records>\n${xmlDelimitedReports}\n</medical_records>`;

      let systemPrompt = prompts.RAG_PROMPT_TEMPLATE(contextText, normLang, coverageStr);

      const uniqueDocsCount = new Set(contextChunks.map((c) => c.documentId)).size;
      systemPrompt += `\n\nIMPORTANT DOCUMENT COUNT INSTRUCTION: You have been provided with extracted context from EXACTLY ${uniqueDocsCount} distinct medical report(s). If asked for an overview, summary, or total count of reports, you MUST state that there are exactly ${uniqueDocsCount} report(s). Do NOT hallucinate any other number.`;

      if (patientContextStr) {
        systemPrompt += `\n\n<patient_observations>\n${patientContextStr}\n</patient_observations>`;
      }
      systemPrompt += `\n\n<question>\n${userQuery}\n</question>`;

      const instructionContent =
        prompts.STRICT_LANGUAGE_INSTRUCTIONS[normLang] ||
        prompts.STRICT_LANGUAGE_INSTRUCTIONS.english;
      systemPrompt += `\n\n${instructionContent}`;
      const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

      // eslint-disable-next-line no-console
      console.log(
        `[ChatService] Running grounded clinical QA (generation in ${normLang}) using ${env.chatModel}...`,
      );

      // Buffer LLM generation to prevent streaming unvalidated patient-specific clinical claims directly to user (REQ-MED-02)
      let rawAnswer = await ollamaClient.chat(formattedMessages, env.chatModel, {
        temperature: 0.2,
        maxTokens: 4096,
        think: false,
        rawOptions: {
          num_ctx: env.ollamaNumCtx,
          repeat_penalty: 1.2,
          repeat_last_n: 64,
        },
        signal: abortSignal,
      });

      // Post-Generation Anti-Hallucination Gate (REQ-MED-02)
      const factValidation = medicalFactValidatorService.verifyMedicalFacts(
        rawAnswer,
        structuredRecords,
      );
      const answer = factValidation.sanitizedText;

      // Stream validated answer to client
      if (onChunk && !abortSignal?.aborted) {
        await streamTextLikeChat(answer, onChunk, abortSignal, 10);
      }

      const citations = [];
      const seenCitations = new Set();
      for (const chunk of contextChunks) {
        const docId = chunk.documentId;
        const pageNo = chunk.pageNumber != null ? Number(chunk.pageNumber) : 1;
        const key = `${docId}_p${pageNo}`;
        if (docId && !seenCitations.has(key)) {
          seenCitations.add(key);
          citations.push({
            documentId: docId,
            fileName: chunk.fileName || "Medical Report",
            pageNumber: pageNo,
            relevanceScore:
              chunk.relevanceScore != null ? Number(Number(chunk.relevanceScore).toFixed(2)) : 1.0,
            excerpt: chunk.content ? chunk.content.substring(0, 160).trim() : null,
          });
        }
      }

      return {
        answer,
        mode,
        emergency: false,
        citations,
      };
    }

    let systemPrompt = prompts.GENERAL_HEALTH_PROMPT(normLang);
    if (patientContextStr) {
      systemPrompt += `\n\n<patient_observations>\n${patientContextStr}\n</patient_observations>`;
    }
    systemPrompt += `\n\n<question>\n${userQuery}\n</question>`;

    const instructionContent =
      prompts.STRICT_LANGUAGE_INSTRUCTIONS[normLang] ||
      prompts.STRICT_LANGUAGE_INSTRUCTIONS.english;
    systemPrompt += `\n\n${instructionContent}`;
    const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

    // eslint-disable-next-line no-console
    console.log(
      `[ChatService] Running local general chat (generation in ${normLang}) using ${env.chatModel}...`,
    );

    const genOptions = {
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
    if (onChunk) {
      await ollamaClient.chatStream(
        formattedMessages,
        env.chatModel,
        (chunk) => {
          answer += chunk;
          onChunk(chunk);
        },
        genOptions,
      );
    } else {
      answer = await ollamaClient.chat(formattedMessages, env.chatModel, genOptions);
    }

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

  async listSessions({ userId, cursor, limit, type, excludeOnboarding }) {
    return chatSessionRepository.listSessions({ cursor, limit, userId, type, excludeOnboarding });
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

    // Heal / synchronize REVIEW_MEDICINES_LIST messages with confirmed medicines (including user-added ones like Testing_1)
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      const action =
        msg.action || msg.actionType || msg.metadata?.action || msg.metadata?.actionType;
      if (msg.role === "assistant" && action === "REVIEW_MEDICINES_LIST") {
        const confirmTurn = items.find(
          (m, idx) =>
            idx > i &&
            (m.actionType === "CONFIRM_MEDICINES" ||
              m.action === "CONFIRM_MEDICINES" ||
              m.metadata?.actionType === "CONFIRM_MEDICINES" ||
              m.metadata?.action === "CONFIRM_MEDICINES" ||
              (typeof m.metadata?.rawValue === "string" &&
                m.metadata.rawValue.includes('"medicines"')) ||
              (typeof m.metadata?.rawValue === "object" && m.metadata?.rawValue?.medicines)),
        );

        let confirmedMedsList = null;
        if (confirmTurn) {
          if (Array.isArray(confirmTurn.medicines) && confirmTurn.medicines.length > 0) {
            confirmedMedsList = confirmTurn.medicines;
          } else if (
            Array.isArray(confirmTurn.metadata?.medicines) &&
            confirmTurn.metadata.medicines.length > 0
          ) {
            confirmedMedsList = confirmTurn.metadata.medicines;
          } else {
            let rawVal = confirmTurn.metadata?.rawValue;
            if (typeof rawVal === "string") {
              try {
                rawVal = JSON.parse(rawVal);
              } catch {
                // ignore
              }
            }
            if (Array.isArray(rawVal?.medicines) && rawVal.medicines.length > 0) {
              confirmedMedsList = rawVal.medicines;
            }
          }
        }

        if (
          Array.isArray(confirmedMedsList) &&
          confirmedMedsList.length > (msg.medicines?.length || 0)
        ) {
          const updatedMeds = confirmedMedsList.map((m) => ({
            ...m,
            selected: true,
            isSaved: true,
          }));
          msg.medicines = updatedMeds;
          if (msg.metadata) {
            msg.metadata.medicines = updatedMeds;
          }
          chatSessionRepository
            .updateMessageMetadata(msg.id, { ...(msg.metadata || {}), medicines: updatedMeds })
            .catch(() => {});
        }
      }
    }

    return { ...result, items };
  }

  async sendMessage({
    userId,
    documentId,
    mentions,
    scopeMode,
    patientId,
    question,
    sessionId: reqSessionId,
    preferredLanguage: passedLang,
    onChunk,
    abortSignal,
    page,
    limit,
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
      // 0. Resolve session early to access conversation slots
      let session;
      if (reqSessionId) {
        session = await chatSessionRepository.findSessionById(reqSessionId, userId);
        if (!session) {
          session = await this.getOrCreateCanonicalSession({ userId });
        }
      } else {
        session = await this.getOrCreateCanonicalSession({ userId });
      }
      const sessionId = session.id;
      const sessionSlots = session.metadata?.slots || {};

      // Resolve normalized language early so document authorization handlers return localized messages
      let earlyPreferredLanguage = passedLang || sessionSlots.preferredLanguage || "english";
      if (!passedLang) {
        try {
          const p = await patientRepository.findById(userId);
          if (p?.preferredLanguage) {
            earlyPreferredLanguage = p.preferredLanguage;
          }
        } catch {
          // Fall back to default
        }
      }
      const normLang = normalizeLanguage(earlyPreferredLanguage);

      // 1. Deterministic Scope Resolution (Priority 1: Mentions / Explicit Doc IDs, Priority 2: NL / Clarification, Priority 3: Session Slots, Priority 4: Authorized History)
      let resolvedScopeMode = scopeMode || null;
      let authorizedDocs = [];
      let finalDocumentIds = [];

      // Extract document IDs from explicit mentions
      const mentionDocIds = Array.isArray(mentions)
        ? mentions.map((m) => (m && typeof m === "object" ? m.documentId : m)).filter(Boolean)
        : [];

      // Combine with explicit documentId if provided
      const rawExplicitDocInput = [];
      if (documentId) {
        if (Array.isArray(documentId)) {
          rawExplicitDocInput.push(...documentId);
        } else if (String(documentId).trim().length > 0) {
          rawExplicitDocInput.push(String(documentId).trim());
        }
      }
      if (mentionDocIds.length > 0) {
        rawExplicitDocInput.push(...mentionDocIds);
      }

      const explicitDocIds = Array.from(
        new Set(
          rawExplicitDocInput
            .map((id) => (typeof id === "string" ? id.trim() : String(id || "").trim()))
            .filter((id) => id.length > 0),
        ),
      );
      const hasExplicitDocInput = explicitDocIds.length > 0;

      if (hasExplicitDocInput) {
        try {
          const authRes = await documentAuthorizationService.authorizeDocumentIds(
            userId,
            explicitDocIds,
            { patientId },
          );

          if (authRes?.isProcessing) {
            const processingMsg =
              DOCUMENT_STILL_PROCESSING_I18N[normLang] || DOCUMENT_STILL_PROCESSING_I18N.english;
            if (onChunk) onChunk(processingMsg);
            const userMsg = await chatSessionRepository.appendMessage({
              content: question?.trim() || "",
              role: "user",
              sessionId,
              userId,
            });
            const aiMsg = await chatSessionRepository.appendMessage({
              citations: [],
              content: processingMsg,
              metadata: {
                mode: "DOCUMENT_PROCESSING",
                scopeMode: "DOCUMENT_PROCESSING",
              },
              role: "assistant",
              sessionId,
              userId,
            });
            return {
              ai: aiMsg,
              citations: [],
              reply: processingMsg,
              user: userMsg,
              mode: "DOCUMENT_PROCESSING",
            };
          }

          finalDocumentIds = authRes.authorizedDocumentIds;
          authorizedDocs = authRes.documents;
          resolvedScopeMode =
            resolvedScopeMode ||
            (finalDocumentIds.length === 1 ? "SINGLE_DOCUMENT" : "MULTI_DOCUMENT");
        } catch (authErr) {
          console.warn("[ChatService] Explicit document authorization failed:", authErr.message);
          const fallbackUnavailableMsg =
            DOCUMENT_UNAVAILABLE_I18N[normLang] || DOCUMENT_UNAVAILABLE_I18N.english;
          if (onChunk) onChunk(fallbackUnavailableMsg);
          const userMsg = await chatSessionRepository.appendMessage({
            content: question?.trim() || "",
            role: "user",
            sessionId,
            userId,
          });
          const aiMsg = await chatSessionRepository.appendMessage({
            citations: [],
            content: fallbackUnavailableMsg,
            metadata: {
              mode: "DOCUMENT_UNAVAILABLE",
              scopeMode: "DOCUMENT_UNAVAILABLE",
            },
            role: "assistant",
            sessionId,
            userId,
          });
          return {
            ai: aiMsg,
            citations: [],
            reply: fallbackUnavailableMsg,
            user: userMsg,
            mode: "DOCUMENT_UNAVAILABLE",
          };
        }
      } else if (scopeMode === "AUTHORIZED_HISTORY") {
        resolvedScopeMode = "AUTHORIZED_HISTORY";
        finalDocumentIds = [];
      } else {
        // Priority 2: Natural Language Document Resolver
        const nlRes = await documentResolverService.resolveNaturalLanguageScope(
          userId,
          question,
          sessionSlots,
        );

        if (nlRes.scopeMode === "REQUIRE_DOCUMENT_SELECTION") {
          const disambiguationMsg =
            "I found multiple matching reports. Please specify which report you want to discuss:\n" +
            nlRes.candidateDocuments
              .map((d, i) => {
                const rDate = d.reportDate || d.createdAt;
                const dateStr =
                  rDate && !isNaN(new Date(rDate))
                    ? new Date(rDate).toLocaleDateString()
                    : "Unknown date";
                return `${i + 1}. ${d.fileName} (${d.hospitalName || d.documentType} - ${dateStr})`;
              })
              .join("\n");

          if (onChunk) onChunk(disambiguationMsg);
          const userMsg = await chatSessionRepository.appendMessage({
            content: question?.trim() || "",
            role: "user",
            sessionId,
            userId,
          });
          const aiMsg = await chatSessionRepository.appendMessage({
            citations: [],
            content: disambiguationMsg,
            metadata: {
              mode: "REQUIRE_SELECTION",
              candidateDocuments: nlRes.candidateDocuments,
              scopeMode: "REQUIRE_DOCUMENT_SELECTION",
            },
            role: "assistant",
            sessionId,
            userId,
          });

          return {
            ai: aiMsg,
            citations: [],
            reply: disambiguationMsg,
            user: userMsg,
            mode: "REQUIRE_SELECTION",
            requireSelection: true,
            candidateDocuments: nlRes.candidateDocuments,
          };
        } else if (nlRes.resolved && nlRes.comparison) {
          resolvedScopeMode = "MULTI_DOCUMENT";
          const authRes = await documentAuthorizationService.authorizeDocumentIds(
            userId,
            nlRes.documentIds,
            { patientId },
          );
          finalDocumentIds = authRes.authorizedDocumentIds;
          authorizedDocs = authRes.documents;
        } else if (nlRes.resolved && nlRes.isHistorical) {
          resolvedScopeMode = "AUTHORIZED_HISTORY";
          finalDocumentIds = [];
        } else if (nlRes.resolved && nlRes.documentIds?.length > 0) {
          resolvedScopeMode = nlRes.scopeMode || "SINGLE_DOCUMENT";
          const authRes = await documentAuthorizationService.authorizeDocumentIds(
            userId,
            nlRes.documentIds,
            { patientId },
          );
          finalDocumentIds = authRes.authorizedDocumentIds;
          authorizedDocs = authRes.documents;
        } else {
          // Priority 3: Carry over active document scope from conversation session slots
          if (
            sessionSlots.activeDocumentIds &&
            sessionSlots.activeDocumentIds.length > 0 &&
            sessionSlots.scopeMode !== "AUTHORIZED_HISTORY"
          ) {
            try {
              const authRes = await documentAuthorizationService.authorizeDocumentIds(
                userId,
                sessionSlots.activeDocumentIds,
                { patientId },
              );
              finalDocumentIds = authRes.authorizedDocumentIds;
              authorizedDocs = authRes.documents;
              resolvedScopeMode =
                sessionSlots.scopeMode ||
                (finalDocumentIds.length === 1 ? "SINGLE_DOCUMENT" : "MULTI_DOCUMENT");
            } catch {
              finalDocumentIds = [];
              resolvedScopeMode = "AUTHORIZED_HISTORY";
            }
          } else {
            // Priority 4: Fallback to AUTHORIZED_HISTORY
            resolvedScopeMode = "AUTHORIZED_HISTORY";
            finalDocumentIds = [];
          }
        }
      }

      documentId = finalDocumentIds;
      scopeMode = resolvedScopeMode;

      const _reqStartTime = Date.now();
      // const baseTime = onChunk?.startTime || _reqStartTime;

      debugLogger.info("sendMessage: Incoming payload", {
        userId,
        documentId,
        scopeMode,
        reqSessionId,
        question: question?.substring(0, 100),
      });

      if (!question?.trim()) {
        if (documentId && documentId.length > 0) {
          const recentMsgs = await chatSessionRepository.listMessages({
            direction: "before",
            limit: 10,
            sessionId,
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

      if (!question?.trim()) {
        throw new InvalidRequestException("Question is required");
      }

      const p = await patientRepository.findById(userId);
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
      const patientPreferredLang = preferredLanguage;

      // --- ML & ROMANIZED LANGUAGE DETECTION (REQ-ML-01..05) ---
      let detectedLanguage = preferredLanguage;
      let detectedLanguageMeta = null;
      let effectiveQuestion = question;

      try {
        const detectStartTime = Date.now();
        // Strip @mention tokens (e.g. "@Urocare Report") so document names do not bias language detection
        const textForLangDetection =
          question
            .replace(/@[^\s@]+/g, "")
            .replace(/\s+/g, " ")
            .trim() || question;

        const langResult = await aiClient.detectLanguage(
          textForLangDetection,
          patientPreferredLang,
        );
        const detectDuration = Date.now() - detectStartTime;

        if (langResult) {
          detectedLanguageMeta =
            typeof langResult === "object" ? langResult : { language: langResult };
          const normDetected = normalizeLanguage(detectedLanguageMeta.language);

          debugLogger.info(`sendMessage: [LANGUAGE DETECTION] took ${detectDuration}ms`, {
            detected: normDetected,
            script: detectedLanguageMeta.script,
            inputScript: detectedLanguageMeta.inputScript,
            isRomanized: detectedLanguageMeta.isRomanized,
            hasExplicitOverride: detectedLanguageMeta.hasExplicitOverride,
            previous: preferredLanguage,
          });

          detectedLanguage = normDetected;
          if (detectedLanguageMeta.hasExplicitOverride && detectedLanguageMeta.cleanText) {
            effectiveQuestion = detectedLanguageMeta.cleanText;
          }
        }
      } catch (err) {
        debugLogger.error("sendMessage: Failed to detect language via ML model", {
          error: err.message,
        });
      }

      // Output language is the verified detected or explicitly overridden language
      preferredLanguage = detectedLanguage;
      const retrievalQuery = effectiveQuestion;
      let englishQuestion = effectiveQuestion;

      // Translate regional prompt to English for cross-lingual RAG retrieval if needed
      const inputLanguage = normalizeLanguage(
        detectedLanguageMeta?.inputLanguage || detectedLanguageMeta?.language || detectedLanguage,
      );
      if (inputLanguage !== "english") {
        try {
          englishQuestion = await aiClient.translate(effectiveQuestion, inputLanguage, "english");
        } catch {
          englishQuestion = effectiveQuestion;
        }
      }

      // Intercept specific questions
      const cleanQuestion = question.toLowerCase().replace(/[?.]/g, "").trim();
      let interceptedReply = null;

      if (AGE_KEYWORDS.includes(cleanQuestion)) {
        const ageTemplates = AGE_REPLY_I18N[detectedLanguage] || AGE_REPLY_I18N.english;
        if (p && p.dateOfBirth) {
          let dobStr =
            p.dateOfBirth instanceof Date
              ? p.dateOfBirth.toISOString().split("T")[0]
              : String(p.dateOfBirth).split("T")[0];
          const calculatedAge = getAgeFromDateOfBirth(p.dateOfBirth);
          interceptedReply = ageTemplates.success(dobStr, calculatedAge);
        } else {
          interceptedReply = ageTemplates.missing;
        }
      }

      if (documentId && documentId.length > 0) {
        const docIdsToAttach = Array.isArray(documentId) ? documentId : [documentId];
        for (const docId of docIdsToAttach) {
          if (docId) {
            await chatSessionRepository.attachDocument(sessionId, userId, docId);
          }
        }
      }

      if (interceptedReply !== null) {
        const userMsg = await chatSessionRepository.appendMessage({
          content: question.trim(),
          role: "user",
          sessionId,
          userId,
        });
        const aiMsg = await chatSessionRepository.appendMessage({
          citations: [],
          content: interceptedReply,
          metadata: { mode: "GENERAL_HEALTH", emergency: false, intercepted: true, documentId: [] },
          role: "assistant",
          sessionId,
          userId,
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

      const hasCompareIntent =
        resolvedScopeMode === "MULTI_DOCUMENT" ||
        (finalDocumentIds && finalDocumentIds.length > 1) ||
        /\b(compare|both|all|reports|trend|versus|vs)\b/i.test(cleanQuestion) ||
        /સરખામણી|બંને|બધાય|તુલના/i.test(cleanQuestion);

      const isSummaryRequest =
        !hasCompareIntent &&
        (SUMMARY_KEYWORDS.some((kw) => cleanQuestion.includes(kw)) ||
          ((cleanQuestion.includes("summary") ||
            cleanQuestion.includes("saransh") ||
            cleanQuestion.includes("સારાંશ") ||
            cleanQuestion.includes("सारांश") ||
            cleanQuestion.includes("samjhavo") ||
            cleanQuestion.includes("samjhao") ||
            cleanQuestion.includes("સમજાવો")) &&
            (cleanQuestion.includes("report") ||
              cleanQuestion.includes("document") ||
              cleanQuestion.includes("રિપોર્ટ") ||
              cleanQuestion.includes("અહેવાલ") ||
              cleanQuestion.includes("દાખલો") ||
              cleanQuestion.includes("કાગળ") ||
              cleanQuestion.includes("रिपोर्ट"))));
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
          const allDocs = await db
            .select()
            .from(document)
            .where(and(eq(document.userId, userId), eq(document.softDelete, false)))
            .orderBy(desc(document.createdAt));

          if (allDocs.length === 0) {
            targetDoc = null;
          } else if (allDocs.length === 1) {
            targetDoc = allDocs[0];
          } else {
            // User has multiple documents and didn't select one.
            // Check if natural language matched specific document(s) or latest/first
            const lowerQ = cleanQuestion;
            const isLatest =
              lowerQ.includes("last") ||
              lowerQ.includes("latest") ||
              lowerQ.includes("recent") ||
              lowerQ.includes("છેલ્લો") ||
              lowerQ.includes("છેલ્લા") ||
              lowerQ.includes("છેલ્લી") ||
              lowerQ.includes("તાજેતરનો") ||
              lowerQ.includes("તાજેતરના") ||
              lowerQ.includes("નવો") ||
              lowerQ.includes("નવી");

            const isOldest =
              lowerQ.includes("first") ||
              lowerQ.includes("oldest") ||
              lowerQ.includes("earliest") ||
              lowerQ.includes("પહેલો") ||
              lowerQ.includes("પહેલા") ||
              lowerQ.includes("પહેલી");

            const matchedDocs = allDocs.filter((d) => {
              if (d.fileName) {
                const cleanName = d.fileName
                  .toLowerCase()
                  .replace(/\.[^/.]+$/, "")
                  .trim();
                if (
                  cleanName.length > 3 &&
                  !["report", "reports", "document", "documents", "file", "files"].includes(
                    cleanName,
                  )
                ) {
                  if (lowerQ.includes(cleanName)) return true;
                }
              }
              return false;
            });

            if (isLatest) {
              targetDoc = allDocs[0];
            } else if (isOldest) {
              targetDoc = allDocs[allDocs.length - 1];
            } else if (matchedDocs.length === 1) {
              targetDoc = matchedDocs[0];
            } else {
              // Ambiguous: multiple documents available. Ask user to select report!
              const userMsg = await chatSessionRepository.appendMessage({
                content: question.trim(),
                role: "user",
                sessionId,
                userId,
              });
              const replyText =
                REQUIRE_SELECTION_REPORT_I18N[detectedLanguage] ||
                REQUIRE_SELECTION_REPORT_I18N[patientPreferredLang] ||
                REQUIRE_SELECTION_REPORT_I18N.english;
              if (onChunk) {
                await streamTextLikeChat(replyText, onChunk, abortSignal, 15);
              }
              const aiMsg = await chatSessionRepository.appendMessage({
                citations: [],
                content: replyText,
                metadata: {
                  mode: "DOCUMENT_RAG",
                  emergency: false,
                  requireSelection: true,
                  documentId: [],
                  reports: allDocs,
                },
                role: "assistant",
                sessionId,
                userId,
              });
              return {
                ai: aiMsg,
                user: userMsg,
                reply: replyText,
                requireSelection: true,
                reports: allDocs,
                mode: "DOCUMENT_RAG",
                emergency: false,
              };
            }
          }
        }

        const userMessage = await chatSessionRepository.appendMessage({
          content: question.trim(),
          role: "user",
          sessionId,
          userId,
        });

        let replyText = "";
        let options = [];
        let taskMode = "DOCUMENT_RAG";
        let rawSummary = "";

        if (!targetDoc) {
          replyText = NO_REPORT_FOUND_I18N[patientPreferredLang] || NO_REPORT_FOUND_I18N.english;
          if (onChunk) {
            onChunk(replyText);
          }
        } else if (
          targetDoc.ocrStatus === ocrStatus.PENDING ||
          targetDoc.ocrStatus === ocrStatus.IN_PROGRESS ||
          targetDoc.ocrStatus === "processing"
        ) {
          replyText =
            REPORT_PROCESSING_I18N[patientPreferredLang] || REPORT_PROCESSING_I18N.english;
          if (onChunk) {
            onChunk(replyText);
          }
        } else {
          const patientName =
            targetDoc.structuredExtractedData?.patient?.name ||
            targetDoc.structuredExtractedData?.patientName ||
            (p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "Unknown");

          const summaryOutputLang =
            detectedLanguageMeta?.hasExplicitOverride || detectedLanguage !== "english"
              ? detectedLanguage
              : patientPreferredLang || "english";

          const reportAgeStr = getReportAgeString(
            targetDoc.reportDate || targetDoc.createdAt,
            summaryOutputLang,
          );

          let structData = targetDoc.structuredExtractedData;
          if (typeof structData === "string") {
            try {
              structData = JSON.parse(structData);
            } catch {
              structData = {};
            }
          }
          rawSummary =
            targetDoc.summaryEnglish ||
            structData?.summaryEnglish ||
            structData?.summary ||
            structData?.remarks ||
            "";

          const labels = SUMMARY_LABELS_I18N[summaryOutputLang] || SUMMARY_LABELS_I18N.english;
          const questions =
            PREDEFINED_QUESTIONS_I18N[summaryOutputLang] || PREDEFINED_QUESTIONS_I18N.english;

          const formattedHeader =
            `**${labels.patientName}:** ${patientName}\n` +
            `**${labels.reportAge}:** ${reportAgeStr}\n\n` +
            `### ${labels.summaryTitle}\n`;

          if (onChunk) {
            await streamTextLikeChat(formattedHeader, onChunk, abortSignal, 10);
          }

          let translatedSummaryParts = [];
          if (!rawSummary) {
            const noSummary =
              NO_SUMMARY_AVAILABLE_I18N[summaryOutputLang] || NO_SUMMARY_AVAILABLE_I18N.english;
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

              if (summaryOutputLang !== "english") {
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
                      summaryOutputLang,
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

        const summaryCitations = targetDoc
          ? [
              {
                documentId: targetDoc.id,
                fileName: targetDoc.fileName || "Medical Report",
                pageNumber: 1,
                reportDate: targetDoc.reportDate || null,
                documentType: targetDoc.documentType || null,
                relevanceScore: 1.0,
                excerpt: rawSummary ? rawSummary.substring(0, 160).trim() : null,
              },
            ]
          : [];

        const aiMessage = await chatSessionRepository.appendMessage({
          citations: summaryCitations,
          content: replyText,
          metadata: {
            mode: taskMode,
            emergency: false,
            documentId: targetDoc ? [targetDoc.id] : [],
            task: "SUMMARY",
            options,
            citations: summaryCitations,
          },
          role: "assistant",
          sessionId,
          userId,
        });

        return {
          ai: aiMessage,
          citations: summaryCitations,
          reply: replyText,
          user: userMessage,
          mode: taskMode,
          emergency: false,
          options,
        };
      }

      // FAST-PATH & MEDICAL INTENT INTERCEPTOR (Direct deterministic domain answers & deflections)
      const DEFLECTION_I18N = {
        english:
          "I am your Health Vault medical assistant. I can only assist with your health records, lab reports, medications, and clinical questions.",
        gujarati:
          "હું તમારો હેલ્થ વૉલ્ટ સહાયક છું. હું ફક્ત તમારા સ્વાસ્થ્ય અહેવાલો, લેબ પરિણામો અને દવાઓ સંબંધિત પ્રશ્નોમાં મદદ કરી શકું છું.",
        hindi:
          "मैं आपका हेल्थ वॉल्ट मेडिकल असिस्टेंट हूं। मैं केवल आपकी स्वास्थ्य रिपोर्ट, लैब टेस्ट और दवाओं से संबंधित प्रश्नों में सहायता कर सकता हूं।",
        marathi:
          "मी तुमचा हेल्थ वॉल्ट वैद्यकीय सहाय्यक आहे. मी फक्त तुमचे आरोग्य अहवाल, लॅब चाचण्या आणि औषधांशी संबंधित प्रश्नांमध्ये मदत करू शकतो.",
        tamil:
          "நான் உங்கள் ஹெல்த் வால்ட் மருத்துவ உதவியாளர். உங்கள் மருத்துவ அறிக்கைகள், ஆய்வக முடிவுகள் மற்றும் மருந்துகள் தொடர்பான கேள்விகளுக்கு மட்டுமே நான் உதவ முடியும்.",
      };

      const CLARIFICATION_I18N = {
        english:
          "Could you please specify which medical report, lab test, or health metric you would like to know about?",
        gujarati:
          "કૃપા કરીને સ્પષ્ટ કરશો કે તમે કયા મેડિકલ રિપોર્ટ, લેબ ટેસ્ટ અથવા સ્વાસ્થ્ય મેટ્રિક વિશે જાણવા માંગો છો?",
        hindi:
          "कृपया स्पष्ट करें कि आप किस मेडिकल रिपोर्ट, लैब टेस्ट या स्वास्थ्य माप के बारे में जानना चाहते हैं?",
        marathi:
          "कृपया स्पष्ट करा की तुम्हाला कोणत्या वैद्यकीय अहवाल, लॅब चाचणी किंवा आरोग्याविषयी माहिती हवी आहे?",
        tamil:
          "நீங்கள் எந்த மருத்துவ அறிக்கை, ஆய்வக சோதனை அல்லது உடல்நல அளவீடு பற்றி அறிய விரும்புகிறீர்கள் என்பதை தெளிவுபடுத்த முடியுமா?",
      };

      let medicalIntentMeta = null;
      let userMessage = null;

      const getOrAppendUserMessage = async () => {
        if (!userMessage) {
          userMessage = await chatSessionRepository.appendMessage({
            content: question.trim(),
            role: "user",
            sessionId,
            userId,
            metadata: {
              ...(mentions && mentions.length > 0 ? { mentions } : {}),
              scopeMode: resolvedScopeMode,
              documentIds: finalDocumentIds,
            },
          });
        }
        return userMessage;
      };

      // Retrieve existing session slots for multi-turn clinical context (REQ-MEM-02)
      const existingSlots = session?.metadata?.slots || session?.metadata?.conversationSlots || {};

      let classificationResult = null;
      let turnSlots = existingSlots;

      try {
        classificationResult = chatClassifier.classify({
          rawQuestion: question,
          englishQuestion,
          question,
          detectedLanguage,
          documentId,
          sessionContext: existingSlots,
        });

        if (classificationResult && classificationResult.medicalIntent) {
          medicalIntentMeta = classificationResult.medicalIntent;

          // Multi-turn slot resolution
          turnSlots = slotContextService.resolveTurnSlots(
            existingSlots,
            classificationResult,
            detectedLanguageMeta,
            hasExplicitDocInput ? finalDocumentIds : existingSlots.activeDocumentIds || [],
            {
              scopeMode: resolvedScopeMode,
              mentions,
              selectedDocumentMetadata:
                authorizedDocs && authorizedDocs[0]
                  ? {
                      id: authorizedDocs[0].id,
                      fileName: authorizedDocs[0].fileName,
                      hospitalName: authorizedDocs[0].hospitalName,
                      doctorName: authorizedDocs[0].doctorName,
                      reportDate: authorizedDocs[0].reportDate || authorizedDocs[0].createdAt,
                      documentType: authorizedDocs[0].documentType,
                    }
                  : null,
            },
          );

          // Inherit active metric from conversation slots if not explicitly stated in current follow-up turn
          if (!medicalIntentMeta.canonicalMetric && turnSlots.activeMetric) {
            medicalIntentMeta.canonicalMetric = turnSlots.activeMetric;
          }

          chatSessionRepository
            .updateSessionMetadata(sessionId, userId, {
              slots: turnSlots,
              conversationSlots: turnSlots,
            })
            .catch(() => {});

          // 1. OUT_OF_SCOPE Immediate Deflection
          if (medicalIntentMeta.intent === "OUT_OF_SCOPE") {
            const deflectText = DEFLECTION_I18N[detectedLanguage] || DEFLECTION_I18N.english;
            const interceptUserMessage = await getOrAppendUserMessage();
            await streamTextLikeChat(deflectText, onChunk, abortSignal, 10);
            const aiMessage = await chatSessionRepository.appendMessage({
              citations: [],
              content: deflectText,
              metadata: { intent: "OUT_OF_SCOPE", mode: "DEFLECTION" },
              role: "assistant",
              sessionId,
              userId,
            });
            return {
              ai: aiMessage,
              citations: [],
              reply: deflectText,
              user: interceptUserMessage,
              mode: "DEFLECTION",
              emergency: false,
            };
          }

          // 2. CLARIFICATION_REQUIRED Handling
          if (medicalIntentMeta.intent === "CLARIFICATION_REQUIRED") {
            const clarifyText = CLARIFICATION_I18N[detectedLanguage] || CLARIFICATION_I18N.english;
            const interceptUserMessage = await getOrAppendUserMessage();
            await streamTextLikeChat(clarifyText, onChunk, abortSignal, 10);
            const aiMessage = await chatSessionRepository.appendMessage({
              citations: [],
              content: clarifyText,
              metadata: { intent: "CLARIFICATION_REQUIRED", mode: "CLARIFICATION" },
              role: "assistant",
              sessionId,
              userId,
            });
            return {
              ai: aiMessage,
              citations: [],
              reply: clarifyText,
              user: interceptUserMessage,
              mode: "CLARIFICATION",
              emergency: false,
            };
          }

          // 3. MEDICAL_TREND_CHART Dynamic Generation (REQ-CHART-02, REQ-CHART-05, REQ-CHART-06, REQ-DOC-06)
          let chartMetric = medicalIntentMeta.canonicalMetric || turnSlots.activeMetric;
          const chartScopeDocIds =
            scopeMode === "AUTHORIZED_HISTORY"
              ? null
              : documentId && documentId.length > 0
                ? documentId
                : turnSlots.activeDocumentIds || null;

          if (medicalIntentMeta.intent === "MEDICAL_TREND_CHART") {
            if (!chartMetric && chartScopeDocIds && chartScopeDocIds.length > 0) {
              try {
                const docLabs = await patientLabResultRepository.findLabResultsByPatientId(userId, {
                  documentIds: chartScopeDocIds,
                  limit: 50,
                });
                const numericLabs = (docLabs || []).filter(
                  (l) => l.numericValue != null && l.canonicalName,
                );
                const metricCounts = {};
                for (const lab of numericLabs) {
                  metricCounts[lab.canonicalName] = (metricCounts[lab.canonicalName] || 0) + 1;
                }
                const sorted = Object.entries(metricCounts).sort((a, b) => b[1] - a[1]);
                if (sorted.length > 0) {
                  chartMetric = sorted[0][0];
                }
              } catch {
                // Ignore and proceed
              }
            }

            if (chartMetric) {
              const chartRes = await medicalTrendChartService.generateTrendChart({
                userId,
                canonicalKey: chartMetric,
                granularity: medicalIntentMeta.granularity || "date",
                startDate: turnSlots.dateRange?.start,
                endDate: turnSlots.dateRange?.end,
                documentIds: chartScopeDocIds,
                scopeMode,
              });

              if (chartRes.hasData && chartRes.chart) {
                const interceptUserMessage = await getOrAppendUserMessage();
                const isExpl =
                  medicalIntentMeta.isExplanationRequest ||
                  /સમજાવો|સમજાવોને|અર્થ|વિશેષતા|explain|breakdown|meaning/i.test(question);

                let summaryText = "";
                if (detectedLanguage === "gujarati") {
                  const trendGuj =
                    chartRes.chart.summary.trendDirection === "increasing"
                      ? "વધતો (increasing)"
                      : chartRes.chart.summary.trendDirection === "decreasing"
                        ? "ઘટતો (decreasing)"
                        : "સ્થિર (stable)";

                  if (isExpl) {
                    summaryText = `તમારા ${chartRes.chart.title} નો ચકાસાયેલ ચાર્ટ અહીં આપેલ છે:\n\n• **ઐતિહાસિક રેકોર્ડ:** તમારા રિપોર્ટ્સ મુજબ મૂલ્યો **${chartRes.chart.summary.firstValue}** થી **${chartRes.chart.summary.latestValue} ${chartRes.chart.canonicalUnit}** ની વચ્ચે રહ્યા છે.\n• **સામાન્ય સંદર્ભ રેન્જ:** ${chartRes.chart.referenceRange.low != null ? `${chartRes.chart.referenceRange.low} - ${chartRes.chart.referenceRange.high} ${chartRes.chart.canonicalUnit}` : "લાગુ નથી"}.\n• **ક્લિનિકલ વલણ (Trend):** સમય જતાં મૂલ્યોમાં **${trendGuj}** વલણ જોવા મળે છે (${chartRes.chart.summary.totalPoints} અવલોકનોમાંથી).\n\nઆ ચાર્ટ તમારા ચકાસાયેલા લેબ પરિણામો પર આધારિત છે. વધુ વિશ્લેષણ અને યોગ્ય સારવાર માટે તમારા ચિકિત્સક (ડૉક્ટર) નો સંપર્ક કરો.`;
                  } else {
                    summaryText = `આ રહ્યો તમારો ચકાસાયેલ ${chartRes.chart.title}. ઐતિહાસિક તબીબી અવલોકનો દર્શાવે છે કે તમારા મૂલ્યો ${chartRes.chart.summary.firstValue} થી ${chartRes.chart.summary.latestValue} ${chartRes.chart.canonicalUnit} ની વચ્ચે છે (સામાન્ય રેન્જ: ${chartRes.chart.referenceRange.low || 70} - ${chartRes.chart.referenceRange.high || 99} ${chartRes.chart.canonicalUnit}), જે ${chartRes.chart.summary.totalPoints} પરિણામોમાં ${trendGuj} વલણ દર્શાવે છે.`;
                  }
                } else if (detectedLanguage === "hindi") {
                  const trendHindi =
                    chartRes.chart.summary.trendDirection === "increasing"
                      ? "बढ़ता हुआ (increasing)"
                      : chartRes.chart.summary.trendDirection === "decreasing"
                        ? "घटता हुआ (decreasing)"
                        : "स्थिर (stable)";
                  summaryText = `यहाँ आपका सत्यापित ${chartRes.chart.title} है। ऐतिहासिक रीडिंग ${chartRes.chart.summary.firstValue} से ${chartRes.chart.summary.latestValue} ${chartRes.chart.canonicalUnit} के बीच हैं, जो ${chartRes.chart.summary.totalPoints} नैदानिक अवलोकनों में ${trendHindi} ट्रेंड दर्शाती हैं।`;
                } else {
                  if (isExpl) {
                    summaryText = `Here is the clinical explanation of your verified ${chartRes.chart.title}:\n\n• **Historical Range:** Observations span from **${chartRes.chart.summary.firstValue}** to **${chartRes.chart.summary.latestValue} ${chartRes.chart.canonicalUnit}** across ${chartRes.chart.summary.totalPoints} clinical reports.\n• **Reference Standard:** Normal clinical range is ${chartRes.chart.referenceRange.low != null ? `${chartRes.chart.referenceRange.low} - ${chartRes.chart.referenceRange.high} ${chartRes.chart.canonicalUnit}` : "Standard thresholds"}.\n• **Trajectory:** The overall progression shows a **${chartRes.chart.summary.trendDirection}** trend over the recorded period.\n\nPlease discuss these clinical trends with your healthcare provider for diagnostic context.`;
                  } else {
                    summaryText = `Here is your verified ${chartRes.chart.title}. Historical readings range from ${chartRes.chart.summary.firstValue} to ${chartRes.chart.summary.latestValue} ${chartRes.chart.canonicalUnit} showing a ${chartRes.chart.summary.trendDirection} trend across ${chartRes.chart.summary.totalPoints} clinical observations.`;
                  }
                }

                await streamTextLikeChat(summaryText, onChunk, abortSignal, 10);

                const chartCitations = (chartRes.chart.points || [])
                  .filter((p) => p.documentId)
                  .map((p) => ({
                    documentId: p.documentId,
                    fileName: p.documentName || "Medical Report",
                    pageNumber: p.pageNumber || p.pageNo || 1,
                    relevanceScore: 1.0,
                    excerpt: `${chartRes.chart.title}: ${p.value} ${p.unit} on ${p.date}`,
                  }));

                const aiMessage = await chatSessionRepository.appendMessage({
                  citations: chartCitations,
                  content: summaryText,
                  metadata: {
                    intent: "MEDICAL_TREND_CHART",
                    mode: "CHART",
                    chart: chartRes.chart,
                  },
                  role: "assistant",
                  sessionId,
                  userId,
                });

                return {
                  ai: aiMessage,
                  citations: chartCitations,
                  reply: summaryText,
                  chart: chartRes.chart,
                  user: interceptUserMessage,
                  mode: "CHART",
                  emergency: false,
                };
              } else {
                // Explicit missing-data response for verified medical charts
                const interceptUserMessage = await getOrAppendUserMessage();
                const metricName = (chartMetric || "requested medical test").replace(/_/g, " ");
                const emptyMsg =
                  detectedLanguage === "gujarati"
                    ? `તમારા અપલોડ કરેલા મેડિકલ રિપોર્ટ્સમાં ${metricName} માટે કોઈ માન્ય લેબ પરિણામો મળ્યા નથી.`
                    : detectedLanguage === "hindi"
                      ? `आपकी अपलोड की गई मेडिकल रिपोर्ट में ${metricName} के लिए कोई लैब परिणाम नहीं मिले।`
                      : `No verified laboratory observations were found for ${metricName} in your authorized medical reports.`;

                await streamTextLikeChat(emptyMsg, onChunk, abortSignal, 10);
                const aiMessage = await chatSessionRepository.appendMessage({
                  citations: [],
                  content: emptyMsg,
                  metadata: {
                    intent: "MEDICAL_TREND_CHART",
                    mode: "CHART_EMPTY",
                  },
                  role: "assistant",
                  sessionId,
                  userId,
                });

                return {
                  ai: aiMessage,
                  citations: [],
                  reply: emptyMsg,
                  chart: null,
                  user: interceptUserMessage,
                  mode: "CHART_EMPTY",
                  emergency: false,
                };
              }
            }
          }
        }

        if (classificationResult && classificationResult.fastPathType) {
          const fastPathRes = await chatFastPath.execute(
            {
              userId,
              sessionId,
              question,
              detectedLanguage,
              onChunk,
              abortSignal,
              documentId,
              page,
              limit,
            },
            classificationResult,
          );
          if (fastPathRes) {
            return fastPathRes;
          }
        }
      } catch (fastPathErr) {
        debugLogger.error("sendMessage: Fast path execution failed", {
          error: fastPathErr.message,
        });
      }

      // REQUEST ANALYZER
      let intent = "GENERAL";
      let documentScope = "NONE";
      const intentStartTime = Date.now();

      const lowerQuestion = retrievalQuery.toLowerCase();
      const compareKeywords = [
        "all",
        "compare",
        "trends",
        "both",
        "multiple",
        "every",
        "which",
        "highest",
        "lowest",
        "across",
        "સરખામણી",
        "તુલના",
        "तुलना",
        "ஒப்பிடுக",
      ];
      const documentKeywords = [
        "report",
        "lab",
        "result",
        "upload",
        "scan",
        "test",
        "mri",
        "x-ray",
        "prescription",
        "summary",
        "અહેવાલ",
        "રિપોર્ટ",
        "रिपोर्ट",
        "अहवाल",
        "அறிக்கை",
      ];
      const fullDocKeywords = [
        "full",
        "entire",
        "complete",
        "everything",
        "detail",
        "details",
        "all details",
        "બધી વિગતો",
        "સંપૂર્ણ",
        "पूरी",
        "विस्तार",
      ];

      const hasCompare = compareKeywords.some((kw) => lowerQuestion.includes(kw));
      const hasDocument = documentKeywords.some((kw) => lowerQuestion.includes(kw));
      const hasFullDoc = fullDocKeywords.some((kw) => lowerQuestion.includes(kw));

      if (documentId && documentId.length > 0) {
        intent = documentId.length > 1 ? "COMPARE" : "DOCUMENT";
        documentScope = documentId.length > 1 ? "SELECTED_MULTI_DOCUMENT" : "SINGLE_DOCUMENT";
        if (hasFullDoc) documentScope = "FULL_DOCUMENT";
      } else {
        if (hasCompare && hasDocument) {
          intent = "COMPARE";
          documentScope = "ALL_DOCUMENTS";
        } else if (hasCompare && lowerQuestion.includes("report")) {
          intent = "COMPARE";
          documentScope = "ALL_DOCUMENTS";
        } else if (hasCompare) {
          intent = "COMPARE";
          documentScope = "ALL_DOCUMENTS";
        } else if (hasDocument) {
          if (lowerQuestion.includes("reports")) {
            intent = "COMPARE";
            documentScope = "ALL_DOCUMENTS";
          } else {
            intent = "DOCUMENT";
            documentScope = "ALL_DOCUMENTS"; // Needs resolution to pick latest
          }
        } else {
          intent = "GENERAL";
          documentScope = "NONE";
        }
        if (hasFullDoc && intent !== "GENERAL") {
          documentScope = "FULL_DOCUMENT";
        }
      }

      debugLogger.info(
        `sendMessage: [PERFORMANCE] Intent Analyzer took ${Date.now() - intentStartTime}ms`,
        { intent, documentScope, detectedLanguage },
      );

      if (intent === "DOCUMENT" || intent === "COMPARE") {
        if (finalDocumentIds && finalDocumentIds.length > 0) {
          // Scope already established
        } else if (documentId && documentId.length > 0) {
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
            .where(and(eq(document.userId, userId), eq(document.softDelete, false)))
            .orderBy(desc(document.createdAt));

          if (recentDocs.length === 0) {
            const userMsg = await chatSessionRepository.appendMessage({
              content: question.trim(),
              role: "user",
              sessionId,
              userId,
            });
            const replyText =
              NO_REPORT_FOUND_I18N[detectedLanguage] || NO_REPORT_FOUND_I18N.english;
            const aiMsg = await chatSessionRepository.appendMessage({
              citations: [],
              content: replyText,
              metadata: {
                mode: "DOCUMENT_RAG",
                emergency: false,
                documentId: [],
              },
              role: "assistant",
              sessionId,
              userId,
            });
            return {
              ai: aiMsg,
              user: userMsg,
              reply: replyText,
              mode: "DOCUMENT_RAG",
              emergency: false,
            };
          } else if (recentDocs.length === 1) {
            finalDocumentIds = [recentDocs[0].id];
            documentScope = "SINGLE_DOCUMENT";
          } else {
            // User has multiple documents (recentDocs.length > 1)
            // 1. Check if user explicitly asked for latest/recent/last
            const isLatest =
              lowerQuestion.includes("last") ||
              lowerQuestion.includes("latest") ||
              lowerQuestion.includes("recent") ||
              lowerQuestion.includes("છેલ્લો") ||
              lowerQuestion.includes("છેલ્લા") ||
              lowerQuestion.includes("છેલ્લી") ||
              lowerQuestion.includes("તાજેતરનો") ||
              lowerQuestion.includes("તાજેતરના") ||
              lowerQuestion.includes("આખરી") ||
              lowerQuestion.includes("નવો") ||
              lowerQuestion.includes("નવી") ||
              lowerQuestion.includes("पिछला") ||
              lowerQuestion.includes("पिछली") ||
              lowerQuestion.includes("नवीनतम") ||
              lowerQuestion.includes("शेवटचा") ||
              lowerQuestion.includes("கடைசி") ||
              lowerQuestion.includes("சமீபத்திய");

            const isOldest =
              lowerQuestion.includes("first") ||
              lowerQuestion.includes("oldest") ||
              lowerQuestion.includes("earliest") ||
              lowerQuestion.includes("પહેલો") ||
              lowerQuestion.includes("પહેલા") ||
              lowerQuestion.includes("પહેલી") ||
              lowerQuestion.includes("સૌથી જૂનો") ||
              lowerQuestion.includes("पहला") ||
              lowerQuestion.includes("पहली") ||
              lowerQuestion.includes("पहिला") ||
              lowerQuestion.includes("முதல்");

            const isAllOrCompare =
              intent === "COMPARE" ||
              (documentScope === "ALL_DOCUMENTS" &&
                (lowerQuestion.includes("all") ||
                  lowerQuestion.includes("every") ||
                  lowerQuestion.includes("both") ||
                  lowerQuestion.includes("reports") ||
                  lowerQuestion.includes("બધા") ||
                  lowerQuestion.includes("તમામ") ||
                  lowerQuestion.includes("દરેક") ||
                  lowerQuestion.includes("badha") ||
                  lowerQuestion.includes("સારે") ||
                  lowerQuestion.includes("सभी") ||
                  lowerQuestion.includes("सर्व") ||
                  lowerQuestion.includes("அனைத்து")));

            if (isLatest) {
              finalDocumentIds = [recentDocs[0].id];
              documentScope = "SINGLE_DOCUMENT";
            } else if (isOldest) {
              finalDocumentIds = [recentDocs[recentDocs.length - 1].id];
              documentScope = "SINGLE_DOCUMENT";
            } else if (isAllOrCompare) {
              finalDocumentIds = recentDocs.map((d) => d.id);
              documentScope = "ALL_DOCUMENTS";
            } else {
              // Check if natural language matched specific document(s)
              const matchedDocs = recentDocs.filter((d) => {
                if (d.fileName) {
                  const cleanName = d.fileName
                    .toLowerCase()
                    .replace(/\.[^/.]+$/, "")
                    .trim();
                  if (
                    cleanName.length > 3 &&
                    !["report", "reports", "document", "documents", "file", "files"].includes(
                      cleanName,
                    )
                  ) {
                    if (lowerQuestion.includes(cleanName)) return true;
                  }
                }
                return false;
              });

              if (matchedDocs.length === 1) {
                finalDocumentIds = [matchedDocs[0].id];
                documentScope = "SINGLE_DOCUMENT";
              } else if (matchedDocs.length > 1) {
                finalDocumentIds = matchedDocs.map((d) => d.id);
                documentScope = "SELECTED_MULTI_DOCUMENT";
              } else {
                // Ambiguous: User has multiple reports and asked about a singular/unspecified report
                // INV-DOC-03: Never silently dump all 23 documents into RAG!
                const userMsg = await chatSessionRepository.appendMessage({
                  content: question.trim(),
                  role: "user",
                  sessionId,
                  userId,
                });
                const replyText =
                  REQUIRE_SELECTION_REPORT_I18N[detectedLanguage] ||
                  REQUIRE_SELECTION_REPORT_I18N.english;
                const aiMsg = await chatSessionRepository.appendMessage({
                  citations: [],
                  content: replyText,
                  metadata: {
                    mode: "DOCUMENT_RAG",
                    emergency: false,
                    requireSelection: true,
                    documentId: [],
                    reports: recentDocs,
                  },
                  role: "assistant",
                  sessionId,
                  userId,
                });
                return {
                  ai: aiMsg,
                  user: userMsg,
                  reply: replyText,
                  requireSelection: true,
                  reports: recentDocs,
                  mode: "DOCUMENT_RAG",
                  emergency: false,
                };
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
            summaryEnglish: document.summaryEnglish,
          })
          .from(document)
          .where(
            and(
              inArray(document.id, finalDocumentIds),
              eq(document.userId, userId),
              eq(document.softDelete, false),
            ),
          );
        finalDocsMetadata.forEach((d) => {
          docNameMap[d.id] = d;
        });
      }

      if (!userMessage) {
        userMessage = await chatSessionRepository.appendMessage({
          content: question.trim(),
          role: "user",
          sessionId,
          userId,
        });
      }

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
      let assistantText = NO_CONTEXT_REPLY;
      let isEmergency = false;
      let mode = intent === "GENERAL" ? "GENERAL_HEALTH" : "DOCUMENT_RAG";
      let aiResponse = null;
      let summaryChunks = [];

      // Fetch user's dependency-aware smart context
      let medicationsContextStr = "";
      try {
        medicationsContextStr = await buildDependencyAwareContext(userId, question, {
          patient: p,
          detectedLanguage,
          englishQuestion,
        });
      } catch (err) {
        debugLogger.error("sendMessage: Failed to fetch active medications for context", {
          error: err.message,
        });
      }

      let patientContextStr = medicationsContextStr;

      if (!patientContextStr && p) {
        let dobStr = p.dateOfBirth
          ? p.dateOfBirth instanceof Date
            ? p.dateOfBirth.toISOString().split("T")[0]
            : String(p.dateOfBirth).split("T")[0]
          : "Unknown";
        const allergiesStr =
          p.allergies && Array.isArray(p.allergies) && p.allergies.length > 0
            ? p.allergies.join(", ")
            : "None";
        patientContextStr = `Patient Profile Context:\nName: ${p.firstName || ""} ${p.lastName || ""}\nGender: ${p.gender || "Unknown"}\nDate of Birth: ${dobStr}\nBlood Group: ${p.bloodGroup || "Unknown"}\nAllergies: ${allergiesStr}`;
      }

      if (patientContextStr) {
        patientContextStr += `\nIMPORTANT INSTRUCTION: Use the above profile information and active medications ONLY to answer the user's specific question.`;
      }

      if (intent === "GENERAL") {
        try {
          debugLogger.info("sendMessage: [LLM TRACKING] [4] Calling Final Chat for GENERAL (Qwen)");

          const qwenStartTime = Date.now();
          aiResponse = await this.qwenHealthChat(
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
        summaryChunks = [];
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
          summaryChunks = ragResult.summaryChunks || [];
          coverageStr = ragResult.coverageStr || "";

          // Hybrid RAG: Inject verified structured lab observations from relational database (REQ-RAG-03, REQ-DOC-05)
          if (medicalIntentMeta?.canonicalMetric) {
            try {
              const factScopeDocIds =
                scopeMode === "AUTHORIZED_HISTORY"
                  ? null
                  : finalDocumentIds && finalDocumentIds.length > 0
                    ? finalDocumentIds
                    : null;
              const factRes = await medicalFactLookupService.lookupFact(
                userId,
                medicalIntentMeta.canonicalMetric,
                { documentIds: factScopeDocIds },
              );
              if (factRes && factRes.results && factRes.results.length > 0) {
                const tableMd = medicalFactLookupService.formatAsMarkdownTable(factRes.results);
                summaryChunks.unshift({
                  content: `[VERIFIED STRUCTURED CLINICAL OBSERVATIONS FROM DATABASE]\n${tableMd}\n\nINSTRUCTION: The above table contains exact, verified laboratory data. Always cite these exact numbers, units, dates, and reference ranges when answering.`,
                  relevanceScore: 1.0,
                  pageNumber: factRes.results[0]?.pageNo || 1,
                  documentId: factRes.results[0]?.documentId || null,
                });
                debugLogger.info(
                  "sendMessage: Injected structured lab results table into context",
                  {
                    metric: medicalIntentMeta.canonicalMetric,
                    rowCount: factRes.results.length,
                  },
                );
              }
            } catch (factErr) {
              debugLogger.error("sendMessage: Failed to lookup structured lab facts", {
                error: factErr.message,
              });
            }
          }

          // Hybrid RAG: Inject authorized structured medical image observations (MedGemma)
          if (finalDocumentIds && finalDocumentIds.length > 0) {
            for (const docId of finalDocumentIds) {
              const docData = docNameMap[docId];
              if (!docData) continue;
              let struct = docData.structuredExtractedData;
              if (typeof struct === "string") {
                try {
                  struct = JSON.parse(struct);
                } catch {
                  // Empty Block
                }
              }
              const imgAnalysis = struct?.imageAnalysis;
              const summaryEng = docData.summaryEnglish || struct?.summaryEnglish;
              if (imgAnalysis || docData.documentType === "IMAGING_REPORT") {
                const anatomicalRegion =
                  imgAnalysis?.anatomicalRegion || "Diagnostic Radiograph / Scan";
                const suggestedView = imgAnalysis?.suggestedView || "Standard projection";
                const imageQuality = imgAnalysis?.imageQuality || "Screening quality";
                const visibleDetails =
                  imgAnalysis?.visibleDetails ||
                  (Array.isArray(imgAnalysis?.visibleStructures)
                    ? imgAnalysis.visibleStructures.join("; ")
                    : imgAnalysis?.visibleStructures) ||
                  "";
                const uncertainty =
                  imgAnalysis?.uncertainty ||
                  "Preliminary visual screening; requires radiologist correlation.";
                const reportSummary = summaryEng || imgAnalysis?.aiGeneratedDescription || "";

                const imagingBlock = `[AUTHORIZED MEDICAL IMAGE OBSERVATIONS (MEDGEMMA 4B PRELIMINARY SCREENING)]
                  Document: ${docData.fileName || "X-ray / Medical Image"}
                  Anatomical Region: ${anatomicalRegion}
                  Suggested View: ${suggestedView}
                  Technical Quality: ${imageQuality}
                  Visible Details / Landmarks: ${visibleDetails}
                  Uncertainty & Technical Constraints: ${uncertainty}
                  Preliminary Summary: ${reportSummary}
                  Review Status: PENDING_CLINICIAN_REVIEW (Preliminary AI screening; not a confirmed diagnosis or proof of normal anatomy. Formal radiologist review required.)

                  INSTRUCTION: You are answering questions about an authorized medical image. Base your response strictly on the above image observations. Do NOT invent diagnoses or claim definitive pathology-free status. Remind the patient that this is a preliminary AI screening requiring licensed radiologist review.`;

                const alreadyInjected = summaryChunks.some(
                  (c) =>
                    String(c.documentId) === String(docId) &&
                    c.sourceType === "imaging_observations",
                );
                if (!alreadyInjected) {
                  summaryChunks.unshift({
                    content: imagingBlock,
                    relevanceScore: 1.0,
                    pageNumber: 1,
                    documentId: docId,
                    sourceType: "imaging_observations",
                    sectionTitle: "Medical Image Observations",
                    docData: docData,
                  });
                  debugLogger.info(
                    "sendMessage: Injected authorized image observations into context",
                    {
                      documentId: docId,
                      modality: imgAnalysis?.modality || "x_ray",
                    },
                  );
                }
              }
            }
          }
        } catch (err) {
          debugLogger.error("sendMessage: Failed to fetch chunks via vector search", {
            error: err.message,
          });
        }

        if (!summaryChunks.length) {
          assistantText = NO_CONTEXT_REPLY_I18N[detectedLanguage] || NO_CONTEXT_REPLY_I18N.english;
        } else {
          try {
            debugLogger.info("sendMessage: [LLM TRACKING] [4] Calling Final Chat for DOCUMENT_RAG");

            let structuredRecords = [];
            try {
              const filterDocIds =
                scopeMode === "AUTHORIZED_HISTORY"
                  ? null
                  : finalDocumentIds && finalDocumentIds.length > 0
                    ? finalDocumentIds
                    : null;
              structuredRecords = await patientLabResultRepository.findLabResultsByPatientId(
                userId,
                {
                  limit: 50,
                  documentIds: filterDocIds,
                },
              );
            } catch (recErr) {
              debugLogger.error(
                "sendMessage: Failed to load patient lab records for fact verification",
                {
                  error: recErr.message,
                },
              );
            }

            const qwenStartTime = Date.now();
            aiResponse = await this.qwenHealthChat(
              history,
              "DOCUMENT_RAG",
              summaryChunks,
              patientContextStr,
              detectedLanguage,
              coverageStr,
              onChunk,
              abortSignal,
              structuredRecords,
            );
            debugLogger.info(
              `sendMessage: [GROUNDED_QA] ${JSON.stringify({ model: env.chatModel, language: detectedLanguage, contextChunks: summaryChunks.length, generationDuration: Date.now() - qwenStartTime })}`,
            );
            assistantText = aiResponse.answer;
            isEmergency = !!aiResponse.emergency;
          } catch (ragErr) {
            debugLogger.error("sendMessage: LLM Generation failed for DOCUMENT_RAG intent", {
              error: ragErr.message,
              stack: ragErr.stack,
            });
            // eslint-disable-next-line no-console
            console.error(
              `[ChatService] LLM Generation failed for DOCUMENT_RAG: ${ragErr.message}`,
            );
            assistantText =
              NO_CONTEXT_REPLY_I18N[detectedLanguage] || NO_CONTEXT_REPLY_I18N.english;
          }
        }
      }

      // Collect and enrich citations from RAG chunks
      let finalCitations = [];
      if (aiResponse && aiResponse.citations && aiResponse.citations.length > 0) {
        finalCitations = aiResponse.citations.map((c) => {
          const docMeta = docNameMap[c.documentId] || {};
          return {
            ...c,
            fileName: docMeta.fileName || c.fileName || "Medical Report",
            reportDate: docMeta.reportDate || null,
            documentType: docMeta.documentType || null,
          };
        });
      } else if (summaryChunks && summaryChunks.length > 0) {
        const seen = new Set();
        for (const chunk of summaryChunks) {
          const docId = chunk.documentId;
          const pageNo = chunk.pageNumber != null ? Number(chunk.pageNumber) : 1;
          const key = `${docId}_p${pageNo}`;
          if (docId && !seen.has(key)) {
            seen.add(key);
            const docMeta = docNameMap[docId] || {};
            finalCitations.push({
              documentId: docId,
              fileName: docMeta.fileName || chunk.fileName || "Medical Report",
              pageNumber: pageNo,
              reportDate: docMeta.reportDate || null,
              documentType: docMeta.documentType || null,
              relevanceScore:
                chunk.relevanceScore != null
                  ? Number(Number(chunk.relevanceScore).toFixed(2))
                  : 1.0,
              excerpt: chunk.content ? chunk.content.substring(0, 160).trim() : null,
            });
          }
        }
      }

      const aiMessage = await chatSessionRepository.appendMessage({
        citations: finalCitations,
        content: assistantText,
        metadata: {
          mode,
          emergency: isEmergency,
          documentId: finalDocumentIds || [],
          task: intent,
          citations: finalCitations,
          mentions: mentions || [],
          scopeMode: resolvedScopeMode,
        },
        role: "assistant",
        sessionId,
        userId,
      });

      // Persist updated conversation slots to session metadata
      try {
        const finalSlots = slotContextService.resolveTurnSlots(
          turnSlots || sessionSlots,
          classificationResult || { intent },
          detectedLanguageMeta,
          hasExplicitDocInput
            ? finalDocumentIds
            : (turnSlots && turnSlots.activeDocumentIds) || sessionSlots.activeDocumentIds || [],
          {
            scopeMode: resolvedScopeMode,
            mentions,
            selectedDocumentMetadata:
              authorizedDocs && authorizedDocs[0]
                ? {
                    id: authorizedDocs[0].id,
                    fileName: authorizedDocs[0].fileName,
                    hospitalName: authorizedDocs[0].hospitalName,
                    doctorName: authorizedDocs[0].doctorName,
                    reportDate: authorizedDocs[0].reportDate || authorizedDocs[0].createdAt,
                    documentType: authorizedDocs[0].documentType,
                  }
                : null,
          },
        );
        await chatSessionRepository.updateSessionMetadata(sessionId, userId, {
          slots: finalSlots,
          conversationSlots: finalSlots,
        });
      } catch (err) {
        debugLogger.error("sendMessage: Failed to persist session slots", { error: err.message });
      }

      debugLogger.info("sendMessage: Total request execution time", {
        durationSec: ((Date.now() - _reqStartTime) / 1000).toFixed(2),
      });

      return {
        ai: aiMessage,
        citations: finalCitations,
        reply: assistantText,
        user: userMessage,
        mode,
        emergency: isEmergency,
        scopeMode: resolvedScopeMode,
        documentIds: finalDocumentIds,
        mentions: mentions || [],
      };
    } finally {
      if (reqSessionId) processingSessions.delete(reqSessionId);
    }
  }

  async deleteSession({ sessionId, userId }) {
    const updated = await chatSessionRepository.softDeleteSession(sessionId, userId);
    if (!updated) throw new NotFoundException("Chat session not found");
    return updated;
  }

  /**
   * Get or create the single canonical chat session for a patient.
   * Strictly isolated from pre-onboarding chat sessions.
   */
  async getOrCreateCanonicalSession({ userId, title = "Health Assistant", metadata = {} }) {
    if (!userId) {
      throw new InvalidRequestException("User ID is required to get or create a session");
    }

    // 1. Check repository for an existing canonical session
    const canonical = await chatSessionRepository.findCanonicalSession(userId);
    if (canonical) {
      return canonical;
    }

    // 2. Create fresh canonical session for the patient
    const newSession = await chatSessionRepository.createSession({
      userId,
      documentId: null,
      title,
      lastMessageAt: new Date(),
      metadata: {
        ...metadata,
        isCanonical: true,
        type: "CANONICAL",
      },
    });

    return newSession;
  }

  /**
   * Create or retrieve dedicated pre-onboarding session (strictly isolated from canonical QA session).
   */
  async createOnboardingSession({ userId, title = "Health Assistant", metadata = {} }) {
    if (!userId) {
      throw new InvalidRequestException(
        "User ID is required to get or create an onboarding session",
      );
    }

    // 1. Check if user already has an active ONBOARDING session in repository
    try {
      const existing = await chatSessionRepository.findOnboardingSession(userId);
      if (existing && !existing.metadata?.isCanonical) {
        return existing;
      }
    } catch (err) {
      debugLogger.error(
        "createOnboardingSession: Failed checking repository for onboarding session",
        {
          error: err.message,
        },
      );
    }

    // 2. Create dedicated onboarding session with isCanonical: false
    const newSession = await chatSessionRepository.createSession({
      userId,
      documentId: null,
      title,
      lastMessageAt: new Date(),
      metadata: {
        ...metadata,
        type: "ONBOARDING",
        isCanonical: false,
      },
    });

    // 3. Anchor dedicated onboarding session into user_onboarding
    try {
      const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
      if (onboardingRecord) {
        await userOnboardingRepository.updateByUserId(userId, {
          data: { ...(onboardingRecord.data || {}), chatSessionId: newSession.id },
        });
      }
    } catch (err) {
      debugLogger.error(
        "createOnboardingSession: Failed saving chatSessionId to onboarding record",
        {
          error: err.message,
        },
      );
    }

    return newSession;
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
  ChatService,
  triageService,
  ragContextService,
  EMERGENCY_WARNING_I18N,
  buildMedicationsContext,
  getMedicalEntityKeywords,
  getReportAgeString,
};
