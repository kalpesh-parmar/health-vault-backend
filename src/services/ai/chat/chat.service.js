const { env } = require("../../../configs/env");
const { messageConstants } = require("../../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../../exceptions/appError");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { eq, desc, inArray, and } = require("drizzle-orm");
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
  DOCUMENT_STILL_PROCESSING_I18N,
  DOCUMENT_UNAVAILABLE_I18N,
  NO_REPORT_FOUND_I18N,
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

    return { ...result, items };
  }

  async sendMessage({
    userId,
    documentId,
    mentions,
    scopeMode,
    patientId,
    question,
    actionType,
    clientTimestamp,
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

      // Early action handling: explicit scope clear
      if (actionType === "CLEAR_DOCUMENT_SCOPE") {
        return await this.clearSessionScope({ sessionId, userId, clientTimestamp });
      }

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

          // Fail-closed requirement: reject requests if any explicitly selected document is unauthorized.
          // Do not silently drop unauthorized document IDs from comparisons.
          if (
            !authRes?.authorizedDocumentIds ||
            authRes.authorizedDocumentIds.length !== explicitDocIds.length
          ) {
            const unauthorizedMsg =
              normLang === "gujarati"
                ? "તમે ઉલ્લેખ કરેલ એક અથવા વધુ દસ્તાવેજો જોવા માટે અધિકૃત નથી અથવા તે ઉપલબ્ધ નથી."
                : normLang === "hindi"
                  ? "आप निर्दिष्ट किए गए एक या अधिक दस्तावेज़ देखने के लिए अधिकृत नहीं हैं या वे उपलब्ध नहीं हैं।"
                  : "You do not have permission to access one or more of the specified documents, or they could not be found.";
            if (onChunk) onChunk(unauthorizedMsg);
            const userMsg = await chatSessionRepository.appendMessage({
              content: question?.trim() || "",
              role: "user",
              sessionId,
              userId,
            });
            const aiMsg = await chatSessionRepository.appendMessage({
              citations: [],
              content: unauthorizedMsg,
              metadata: {
                mode: "DOCUMENT_UNAUTHORIZED",
                scopeMode: "DOCUMENT_UNAUTHORIZED",
              },
              role: "assistant",
              sessionId,
              userId,
            });
            return {
              ai: aiMsg,
              citations: [],
              reply: unauthorizedMsg,
              user: userMsg,
              mode: "DOCUMENT_UNAUTHORIZED",
              emergency: false,
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

              // Fail-closed requirement: if any previously scoped document is no longer accessible, do not broaden to all documents
              if (
                !authRes?.authorizedDocumentIds ||
                authRes.authorizedDocumentIds.length !== sessionSlots.activeDocumentIds.length
              ) {
                const expiredMsg =
                  DOCUMENT_UNAVAILABLE_I18N[normLang] ||
                  "The previously selected document is no longer accessible or has been removed.";
                if (onChunk) onChunk(expiredMsg);
                const userMsg = await chatSessionRepository.appendMessage({
                  content: question?.trim() || "",
                  role: "user",
                  sessionId,
                  userId,
                });
                const aiMsg = await chatSessionRepository.appendMessage({
                  citations: [],
                  content: expiredMsg,
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
                  reply: expiredMsg,
                  user: userMsg,
                  mode: "DOCUMENT_UNAVAILABLE",
                  emergency: false,
                };
              }

              finalDocumentIds = authRes.authorizedDocumentIds;
              authorizedDocs = authRes.documents;
              resolvedScopeMode =
                sessionSlots.scopeMode ||
                (finalDocumentIds.length === 1 ? "SINGLE_DOCUMENT" : "MULTI_DOCUMENT");
            } catch {
              const expiredMsg =
                DOCUMENT_UNAVAILABLE_I18N[normLang] ||
                "The previously selected document is no longer accessible or has been removed.";
              if (onChunk) onChunk(expiredMsg);
              const userMsg = await chatSessionRepository.appendMessage({
                content: question?.trim() || "",
                role: "user",
                sessionId,
                userId,
              });
              const aiMsg = await chatSessionRepository.appendMessage({
                citations: [],
                content: expiredMsg,
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
                reply: expiredMsg,
                user: userMsg,
                mode: "DOCUMENT_UNAVAILABLE",
                emergency: false,
              };
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

      const isBareDocumentMention = (() => {
        const docCount =
          (finalDocumentIds && finalDocumentIds.length) || (documentId && documentId.length) || 0;
        if (docCount === 0) return false;
        const stripped = cleanQuestion.replace(/@[^\s@]+/g, "").trim();
        const genericSummaryTokens = [
          "",
          "report",
          "reports",
          "document",
          "documents",
          "summary",
          "saransh",
          "details",
          "info",
          "please",
          "this",
          "this report",
          "this document",
          "explain",
          "explain this",
          "overview",
          "full details",
          "about this",
          "tell me",
          "રિપોર્ટ",
          "દસ્તાવેજ",
          "સારાંશ",
          "સમજાવો",
          "વિશે",
          "માહિતી",
          "વિગતો",
          "બધી વિગતો",
          "આ રિપોર્ટ",
          "આ દસ્તાવેજ",
          "આ રિપોર્ટ વિશે",
          "આ રિપોર્ટ સમજાવો",
          "આ રિપોર્ટનો સારાંશ",
          "આ રિપોર્ટ નો સારાંશ",
          "આ રિપોર્ટ જણાવો",
          "આ રિપોર્ટમાં શું છે",
          "આ રિપોર્ટ મા શું છે",
          "આ દસ્તાવેજ વિશે",
          "આ દસ્તાવેજ સમજાવો",
          "આ દસ્તાવેજનો સારાંશ",
          "આ દસ્તાવેજ નો સારાંશ",
          "આ દસ્તાવેજ જણાવો",
          "આ દસ્તાવેજમાં શું છે",
          "આ દસ્તાવેજ મા શું છે",
          "આ રિપોર્ટ વિષે જણાવો",
          "આ રિપોર્ટ વિષે કહો",
          "આ રિપોર્ટ વિશે કહો",
          "આ કાગળ વિશે",
          "આ દાખલા વિશે",
          "આ દાખલો સમજાવો",
          "આ કાગળ સમજાવો",
          "આ રિપોર્ટ આપો",
          "આ રિપોર્ટ બતાવો",
          "આ રિપોર્ટ દેખાડો",
          "આ રિપોર્ટ સમજો",
          "આ રિપોર્ટ સમજવો છે",
          "આ રિપોર્ટ જાણવો છે",
          "આ રિપોર્ટ જોવો છે",
          "આ રિપોર્ટ ની વિગતો",
          "આ રિપોર્ટ ની વિગત",
          "આ રિપોર્ટ નો અહેવાલ",
          "આ અહેવાલ વિશે",
          "આ અહેવાલ સમજાવો",
          "આ અહેવાલ નો સારાંશ",
          "આ અહેવાલ જણાવો",
          "આ અહેવાલમાં શું છે",
          "આ અહેવાલ મા શું છે",
          "આ અહેવાલ વિષે જણાવો",
          "આ અહેવાલ વિષે કહો",
          "આ અહેવાલ વિશે કહો",
          "આ અહેવાલ આપો",
          "આ અહેવાલ બતાવો",
          "આ અહેવાલ દેખાડો",
          "આ અહેવાલ સમજો",
          "આ અહેવાલ સમજવો છે",
          "આ અહેવાલ જાણવો છે",
          "આ અહેવાલ જોવો છે",
          "આ અહેવાલ ની વિગતો",
          "આ અહેવાલ ની વિગત",
          "આ અહેવાલ નો સારાંશ",
          "આ અહેવાલ નો અહેવાલ",
          "આ અહેવાલ નો રિપોર્ટ",
          "આ અહેવાલ નો દાખલો",
          "આ અહેવાલ નો કાગળ",
          "આ અહેવાલ નો દસ્તાવેજ",
          "આ અહેવાલ નો રિપોર્ટ સારાંશ",
          "આ અહેવાલ નો દસ્તાવેજ સારાંશ",
          "આ અહેવાલ નો અહેવાલ સારાંશ",
          "આ અહેવાલ નો દાખલો સારાંશ",
          "આ અહેવાલ નો કાગળ સારાંશ",
          "આ અહેવાલ નો રિપોર્ટ અહેવાલ",
          "આ અહેવાલ નો દસ્તાવેજ અહેવાલ",
          "આ અહેવાલ નો અહેવાલ અહેવાલ",
          "આ અહેવાલ નો દાખલો અહેવાલ",
          "આ અહેવાલ નો કાગળ અહેવાલ",
          "આ અહેવાલ નો રિપોર્ટ વિગત",
          "આ અહેવાલ નો દસ્તાવેજ વિગત",
          "આ અહેવાલ નો અહેવાલ વિગત",
          "આ અહેવાલ નો દાખલો વિગત",
          "આ અહેવાલ નો કાગળ વિગત",
          "આ અહેવાલ નો રિપોર્ટ વિગતો",
          "આ અહેવાલ નો દસ્તાવેજ વિગતો",
          "આ અહેવાલ નો અહેવાલ વિગતો",
          "આ અહેવાલ નો દાખલો વિગતો",
          "આ અહેવાલ નો કાગળ વિગતો",
          "આ અહેવાલ નો રિપોર્ટ માહિતી",
          "આ અહેવાલ નો દસ્તાવેજ માહિતી",
          "આ અહેવાલ નો અહેવાલ માહિતી",
          "આ અહેવાલ નો દાખલો માહિતી",
          "આ અહેવાલ નો કાગળ માહિતી",
          "આ અહેવાલ નો રિપોર્ટ અર્થ",
          "આ અહેવાલ નો દસ્તાવેજ અર્થ",
          "આ અહેવાલ નો અહેવાલ અર્થ",
          "આ અહેવાલ નો દાખલો અર્થ",
          "આ અહેવાલ નો કાગળ અર્થ",
          "આ અહેવાલ નો રિપોર્ટ પરિણામ",
          "આ અહેવાલ નો દસ્તાવેજ પરિણામ",
          "આ અહેવાલ નો અહેવાલ પરિણામ",
          "આ અહેવાલ નો દાખલો પરિણામ",
          "આ અહેવાલ નો કાગળ પરિણામ",
          "આ અહેવાલ નો રિપોર્ટ પરિણામો",
          "આ અહેવાલ નો દસ્તાવેજ પરિણામો",
          "આ અહેવાલ નો અહેવાલ પરિણામો",
          "આ અહેવાલ નો દાખલો પરિણામો",
          "આ અહેવાલ નો કાગળ પરિણામો",
          "આ અહેવાલ નો રિપોર્ટ ટેસ્ટ",
          "આ અહેવાલ નો દસ્તાવેજ ટેસ્ટ",
          "આ અહેવાલ નો અહેવાલ ટેસ્ટ",
          "આ અહેવાલ નો દાખલો ટેસ્ટ",
          "આ અહેવાલ નો કાગળ ટેસ્ટ",
          "આ અહેવાલ નો રિપોર્ટ ટેસ્ટ્સ",
          "આ અહેવાલ નો દસ્તાવેજ ટેસ્ટ્સ",
          "આ અહેવાલ નો અહેવાલ ટેસ્ટ્સ",
          "આ અહેવાલ નો દાખલો ટેસ્ટ્સ",
          "આ અહેવાલ નો કાગળ ટેસ્ટ્સ",
          "આ અહેવાલ નો રિપોર્ટ તપાસ",
          "આ અહેવાલ નો દસ્તાવેજ તપાસ",
          "આ અહેવાલ નો અહેવાલ તપાસ",
          "આ અહેવાલ નો દાખલો તપાસ",
          "આ અહેવાલ નો કાગળ તપાસ",
          "આ અહેવાલ નો રિપોર્ટ રિપોર્ટ",
          "આ અહેવાલ નો દસ્તાવેજ રિપોર્ટ",
          "આ અહેવાલ નો અહેવાલ રિપોર્ટ",
          "આ અહેવાલ નો દાખલો રિપોર્ટ",
          "આ અહેવાલ નો કાગળ રિપોર્ટ",
          "આ અહેવાલ નો રિપોર્ટ દસ્તાવેજ",
          "આ અહેવાલ નો દસ્તાવેજ દસ્તાવેજ",
          "આ અહેવાલ નો અહેવાલ દસ્તાવેજ",
          "આ અહેવાલ નો દાખલો દસ્તાવેજ",
          "આ અહેવાલ નો કાગળ દસ્તાવેજ",
          "આ અહેવાલ નો રિપોર્ટ કાગળ",
          "આ અહેવાલ નો દસ્તાવેજ કાગળ",
          "આ અહેવાલ નો અહેવાલ કાગળ",
          "આ અહેવાલ નો દાખલો કાગળ",
          "આ અહેવાલ નો કાગળ કાગળ",
          "આ અહેવાલ નો રિપોર્ટ દાખલો",
          "આ અહેવાલ નો દસ્તાવેજ દાખલો",
          "આ અહેવાલ નો અહેવાલ દાખલો",
          "આ અહેવાલ નો દાખલો દાખલો",
          "આ અહેવાલ નો કાગળ દાખલો",
          "આ રિપોર્ટનો સારાંશ આપો",
          "આ રિપોર્ટ નો સારાંશ આપો",
          "આ દસ્તાવેજનો સારાંશ આપો",
          "આ દસ્તાવેજ નો સારાંશ આપો",
          "આ અહેવાલનો સારાંશ આપો",
          "આ અહેવાલ નો સારાંશ આપો",
          "આ કાગળનો સારાંશ આપો",
          "આ કાગળ નો સારાંશ આપો",
          "આ દાખલાનો સારાંશ આપો",
          "આ દાખલો નો સારાંશ આપો",
          "આ રિપોર્ટ વિશે કહો",
          "આ રિપોર્ટ વિષે કહો",
          "આ દસ્તાવેજ વિશે કહો",
          "આ દસ્તાવેજ વિષે કહો",
          "આ અહેવાલ વિશે કહો",
          "આ અહેવાલ વિષે કહો",
          "આ કાગળ વિશે કહો",
          "આ કાગળ વિષે કહો",
          "આ દાખલા વિશે કહો",
          "આ દાખલા વિષે કહો",
          "આ રિપોર્ટ સમજાવો",
          "આ દસ્તાવેજ સમજાવો",
          "આ અહેવાલ સમજાવો",
          "આ કાગળ સમજાવો",
          "આ દાખલો સમજાવો",
          "આ રિપોર્ટ વિશે જણાવો",
          "આ રિપોર્ટ વિષે જણાવો",
          "આ દસ્તાવેજ વિશે જણાવો",
          "આ દસ્તાવેજ વિષે જણાવો",
          "આ અહેવાલ વિશે જણાવો",
          "આ અહેવાલ વિષે જણાવો",
          "આ કાગળ વિશે જણાવો",
          "આ કાગળ વિષે જણાવો",
          "આ દાખલા વિશે જણાવો",
          "આ દાખલા વિષે જણાવો",
          "આ રિપોર્ટમાં શું લખેલું છે",
          "આ રિપોર્ટ મા શું લખેલું છે",
          "આ રિપોર્ટમાં શું છે",
          "આ રિપોર્ટ મા શું છે",
          "આ દસ્તાવેજમાં શું લખેલું છે",
          "આ દસ્તાવેજ મા શું લખેલું છે",
          "આ દસ્તાવેજમાં શું છે",
          "આ દસ્તાવેજ મા શું છે",
          "આ અહેવાલમાં શું લખેલું છે",
          "આ અહેવાલ મા શું લખેલું છે",
          "આ અહેવાલમાં શું છે",
          "આ અહેવાલ મા શું છે",
          "આ કાગળમાં શું લખેલું છે",
          "આ કાગળ મા શું લખેલું છે",
          "આ કાગળમાં શું છે",
          "આ કાગળ મા શું છે",
          "આ દાખલામાં શું લખેલું છે",
          "આ દાખલા મા શું લખેલું છે",
          "આ દાખલામાં શું છે",
          "આ દાખલા મા શું છે",
          "આ રિપોર્ટની સારાંશ",
          "આ રિપોર્ટ ની સારાંશ",
          "આ દસ્તાવેજની સારાંશ",
          "આ દસ્તાવેજ ની સારાંશ",
          "આ અહેવાલની સારાંશ",
          "આ અહેવાલ ની સારાંશ",
          "આ કાગળની સારાંશ",
          "આ કાગળ ની સારાંશ",
          "આ દાખલાની સારાંશ",
          "આ દાખલા ની સારાંશ",
          "આ રિપોર્ટનો અહેવાલ",
          "આ રિપોર્ટ નો અહેવાલ",
          "આ દસ્તાવેજનો અહેવાલ",
          "આ દસ્તાવેજ નો અહેવાલ",
          "આ અહેવાલનો અહેવાલ",
          "આ અહેવાલ નો અહેવાલ",
          "આ કાગળનો અહેવાલ",
          "આ કાગળ નો અહેવાલ",
          "આ દાખલાનો અહેવાલ",
          "આ દાખલા નો અહેવાલ",
          "આ રિપોર્ટની માહિતી",
          "આ રિપોર્ટ ની માહિતી",
          "આ દસ્તાવેજની માહિતી",
          "આ દસ્તાવેજ ની માહિતી",
          "આ અહેવાલની માહિતી",
          "આ અહેવાલ ની માહિતી",
          "આ કાગળની માહિતી",
          "આ કાગળ ની માહિતી",
          "આ દાખલાની માહિતી",
          "આ દાખલા ની માહિતી",
          "આ રિપોર્ટની વિગત",
          "આ રિપોર્ટ ની વિગત",
          "આ દસ્તાવેજની વિગત",
          "આ દસ્તાવેજ ની વિગત",
          "આ અહેવાલની વિગત",
          "આ અહેવાલ ની વિગત",
          "આ કાગળની વિગત",
          "આ કાગળ ની વિગત",
          "આ દાખલાની વિગત",
          "આ દાખલા ની વિગત",
          "આ રિપોર્ટની વિગતો",
          "આ રિપોર્ટ ની વિગતો",
          "આ દસ્તાવેજની વિગતો",
          "આ દસ્તાવેજ ની વિગતો",
          "આ અહેવાલની વિગતો",
          "આ અહેવાલ ની વિગતો",
          "આ કાગળની વિગતો",
          "આ કાગળ ની વિગતો",
          "આ દાખલાની વિગતો",
          "આ દાખલા ની વિગતો",
          "આ રિપોર્ટનું પરિણામ",
          "આ રિપોર્ટ નું પરિણામ",
          "આ દસ્તાવેજનું પરિણામ",
          "આ દસ્તાવેજ નું પરિણામ",
          "આ અહેવાલનું પરિણામ",
          "આ અહેવાલ નું પરિણામ",
          "આ કાગળનું પરિણામ",
          "આ કાગળ નું પરિણામ",
          "આ દાખલાનું પરિણામ",
          "આ દાખલા નું પરિણામ",
          "આ રિપોર્ટના પરિણામો",
          "આ રિપોર્ટ ના પરિણામો",
          "આ દસ્તાવેજના પરિણામો",
          "આ દસ્તાવેજ ના પરિણામો",
          "આ અહેવાલના પરિણામો",
          "આ અહેવાલ ના પરિણામો",
          "આ કાગળના પરિણામો",
          "આ કાગળ ના પરિણામો",
          "આ દાખલાના પરિણામો",
          "આ દાખલા ના પરિણામો",
          "આ રિપોર્ટની ટેસ્ટ",
          "આ રિપોર્ટ ની ટેસ્ટ",
          "આ દસ્તાવેજની ટેસ્ટ",
          "આ દસ્તાવેજ ની ટેસ્ટ",
          "આ અહેવાલની ટેસ્ટ",
          "આ અહેવાલ ની ટેસ્ટ",
          "આ કાગળની ટેસ્ટ",
          "આ કાગળ ની ટેસ્ટ",
          "આ દાખલાની ટેસ્ટ",
          "આ દાખલા ની ટેસ્ટ",
          "આ રિપોર્ટના ટેસ્ટ્સ",
          "આ રિપોર્ટ ના ટેસ્ટ્સ",
          "આ દસ્તાવેજના ટેસ્ટ્સ",
          "આ દસ્તાવેજ ના ટેસ્ટ્સ",
          "આ અહેવાલના ટેસ્ટ્સ",
          "આ અહેવાલ ના ટેસ્ટ્સ",
          "આ કાગળના ટેસ્ટ્સ",
          "આ કાગળ ના ટેસ્ટ્સ",
          "આ દાખલાના ટેસ્ટ્સ",
          "આ દાખલા ના ટેસ્ટ્સ",
          "આ રિપોર્ટની તપાસ",
          "આ રિપોર્ટ ની તપાસ",
          "આ દસ્તાવેજની તપાસ",
          "આ દસ્તાવેજ ની તપાસ",
          "આ અહેવાલની તપાસ",
          "આ અહેવાલ ની તપાસ",
          "આ કાગળની તપાસ",
          "આ કાગળ ની તપાસ",
          "આ દાખલાની તપાસ",
          "આ દાખલા ની તપાસ",
          "આ રિપોર્ટનો રિપોર્ટ",
          "આ રિપોર્ટ નો રિપોર્ટ",
          "આ દસ્તાવેજનો રિપોર્ટ",
          "આ દસ્તાવેજ નો રિપોર્ટ",
          "આ અહેવાલનો રિપોર્ટ",
          "આ અહેવાલ નો રિપોર્ટ",
          "આ કાગળનો રિપોર્ટ",
          "આ કાગળ નો રિપોર્ટ",
          "આ દાખલાનો રિપોર્ટ",
          "આ દાખલા નો રિપોર્ટ",
          "આ રિપોર્ટનો દસ્તાવેજ",
          "આ રિપોર્ટ નો દસ્તાવેજ",
          "આ દસ્તાવેજનો દસ્તાવેજ",
          "આ દસ્તાવેજ નો દસ્તાવેજ",
          "આ અહેવાલનો દસ્તાવેજ",
          "આ અહેવાલ નો દસ્તાવેજ",
          "આ કાગળનો દસ્તાવેજ",
          "આ કાગળ નો દસ્તાવેજ",
          "આ દાખલાનો દસ્તાવેજ",
          "આ દાખલા નો દસ્તાવેજ",
          "આ રિપોર્ટનો કાગળ",
          "આ રિપોર્ટ નો કાગળ",
          "આ દસ્તાવેજનો કાગળ",
          "આ દસ્તાવેજ નો કાગળ",
          "આ અહેવાલનો કાગળ",
          "આ અહેવાલ નો કાગળ",
          "આ કાગળનો કાગળ",
          "આ કાગળ નો કાગળ",
          "આ દાખલાનો કાગળ",
          "આ દાખલા નો કાગળ",
          "આ રિપોર્ટનો દાખલો",
          "આ રિપોર્ટ નો દાખલો",
          "આ દસ્તાવેજનો દાખલો",
          "આ દસ્તાવેજ નો દાખલો",
          "આ અહેવાલનો દાખલો",
          "આ અહેવાલ નો દાખલો",
          "આ કાગળનો દાખલો",
          "આ કાગળ નો દાખલો",
          "આ દાખલાનો દાખલો",
          "આ દાખલા નો દાખલો",
          "આ રિપોર્ટનો રિપોર્ટ સારાંશ",
          "આ દસ્તાવેજનો દસ્તાવેજ સારાંશ",
          "આ અહેવાલનો અહેવાલ સારાંશ",
          "આ કાગળનો કાગળ સારાંશ",
          "આ દાખલાનો દાખલો સારાંશ",
          "આ રિપોર્ટનો રિપોર્ટ અહેવાલ",
          "આ દસ્તાવેજનો દસ્તાવેજ અહેવાલ",
          "આ અહેવાલનો અહેવાલ અહેવાલ",
          "આ કાગળનો કાગળ અહેવાલ",
          "આ દાખલાનો દાખલો અહેવાલ",
          "આ રિપોર્ટનો રિપોર્ટ વિગત",
          "આ દસ્તાવેજનો દસ્તાવેજ વિગત",
          "આ અહેવાલનો અહેવાલ વિગત",
          "આ કાગળનો કાગળ વિગત",
          "આ દાખલાનો દાખલો વિગત",
          "આ રિપોર્ટનો રિપોર્ટ વિગતો",
          "આ દસ્તાવેજનો દસ્તાવેજ વિગતો",
          "આ અહેવાલનો અહેવાલ વિગતો",
          "આ કાગળનો કાગળ વિગતો",
          "આ દાખલાનો દાખલો વિગતો",
          "આ રિપોર્ટનો રિપોર્ટ માહિતી",
          "આ દસ્તાવેજનો દસ્તાવેજ માહિતી",
          "આ અહેવાલનો અહેવાલ માહિતી",
          "આ કાગળનો કાગળ માહિતી",
          "આ દાખલાનો દાખલો માહિતી",
          "આ રિપોર્ટનો રિપોર્ટ અર્થ",
          "આ દસ્તાવેજનો દસ્તાવેજ અર્થ",
          "આ અહેવાલનો અહેવાલ અર્થ",
          "આ કાગળનો કાગળ અર્થ",
          "આ દાખલાનો દાખલો અર્થ",
          "આ રિપોર્ટનો રિપોર્ટ પરિણામ",
          "આ દસ્તાવેજનો દસ્તાવેજ પરિણામ",
          "આ અહેવાલનો અહેવાલ પરિણામ",
          "આ કાગળનો કાગળ પરિણામ",
          "આ દાખલાનો દાખલો પરિણામ",
          "આ રિપોર્ટનો રિપોર્ટ પરિણામો",
          "આ દસ્તાવેજનો દસ્તાવેજ પરિણામો",
          "આ અહેવાલનો અહેવાલ પરિણામો",
          "આ કાગળનો કાગળ પરિણામો",
          "આ દાખલાનો દાખલો પરિણામો",
          "આ રિપોર્ટનો રિપોર્ટ ટેસ્ટ",
          "આ દસ્તાવેજનો દસ્તાવેજ ટેસ્ટ",
          "આ અહેવાલનો અહેવાલ ટેસ્ટ",
          "આ કાગળનો કાગળ ટેસ્ટ",
          "આ દાખલાનો દાખલો ટેસ્ટ",
          "આ રિપોર્ટનો રિપોર્ટ ટેસ્ટ્સ",
          "આ દસ્તાવેજનો દસ્તાવેજ ટેસ્ટ્સ",
          "આ અહેવાલનો અહેવાલ ટેસ્ટ્સ",
          "આ કાગળનો કાગળ ટેસ્ટ્સ",
          "આ દાખલાનો દાખલો ટેસ્ટ્સ",
          "આ રિપોર્ટનો રિપોર્ટ તપાસ",
          "આ દસ્તાવેજનો દસ્તાવેજ તપાસ",
          "આ અહેવાલનો અહેવાલ તપાસ",
          "આ કાગળનો કાગળ તપાસ",
          "આ દાખલાનો દાખલો તપાસ",
          "આ રિપોર્ટનો રિપોર્ટ રિપોર્ટ",
          "આ દસ્તાવેજનો દસ્તાવેજ રિપોર્ટ",
          "આ અહેવાલનો અહેવાલ રિપોર્ટ",
          "આ કાગળનો કાગળ રિપોર્ટ",
          "આ દાખલાનો દાખલો રિપોર્ટ",
          "આ રિપોર્ટનો રિપોર્ટ દસ્તાવેજ",
          "આ દસ્તાવેજનો દસ્તાવેજ દસ્તાવેજ",
          "આ અહેવાલનો અહેવાલ દસ્તાવેજ",
          "આ કાગળનો કાગળ દસ્તાવેજ",
          "આ દાખલાનો દાખલો દસ્તાવેજ",
          "આ રિપોર્ટનો રિપોર્ટ કાગળ",
          "આ દસ્તાવેજનો દસ્તાવેજ કાગળ",
          "આ અહેવાલનો અહેવાલ કાગળ",
          "આ કાગળનો કાગળ કાગળ",
          "આ દાખલાનો દાખલો કાગળ",
          "આ રિપોર્ટનો રિપોર્ટ દાખલો",
          "આ દસ્તાવેજનો દસ્તાવેજ દાખલો",
          "આ અહેવાલનો અહેવાલ દાખલો",
          "આ કાગળનો કાગળ દાખલો",
          "આ દાખલાનો દાખલો દાખલો",
          "આ રિપોર્ટનો રિપોર્ટ સારાંશ આપો",
          "આ દસ્તાવેજનો દસ્તાવેજ સારાંશ આપો",
          "આ અહેવાલનો અહેવાલ સારાંશ આપો",
          "આ કાગળનો કાગળ સારાંશ આપો",
          "આ દાખલાનો દાખલો સારાંશ આપો",
          "આ રિપોર્ટનો રિપોર્ટ વિશે કહો",
          "આ દસ્તાવેજનો દસ્તાવેજ વિશે કહો",
          "આ અહેવાલનો અહેવાલ વિશે કહો",
          "આ કાગળનો કાગળ વિશે કહો",
          "આ દાખલાનો દાખલો વિશે કહો",
          "આ રિપોર્ટનો રિપોર્ટ સમજાવો",
          "આ દસ્તાવેજનો દસ્તાવેજ સમજાવો",
          "આ અહેવાલનો અહેવાલ સમજાવો",
          "આ કાગળનો કાગળ સમજાવો",
          "આ દાખલાનો દાખલો સમજાવો",
          "આ રિપોર્ટનો રિપોર્ટ વિશે જણાવો",
          "આ દસ્તાવેજનો દસ્તાવેજ વિશે જણાવો",
          "આ અહેવાલનો અહેવાલ વિશે જણાવો",
          "આ કાગળનો કાગળ વિશે જણાવો",
          "આ દાખલાનો દાખલો વિશે જણાવો",
          "આ રિપોર્ટનો રિપોર્ટમાં શું લખેલું છે",
          "આ દસ્તાવેજનો દસ્તાવેજમાં શું લખેલું છે",
          "આ અહેવાલનો અહેવાલમાં શું લખેલું છે",
          "આ કાગળનો કાગળમાં શું લખેલું છે",
          "આ દાખલાનો દાખલામાં શું લખેલું છે",
          "આ રિપોર્ટનો રિપોર્ટમાં શું છે",
          "આ દસ્તાવેજનો દસ્તાવેજમાં શું છે",
          "આ અહેવાલનો અહેવાલમાં શું છે",
          "આ કાગળનો કાગળમાં શું છે",
          "આ દાખલાનો દાખલામાં શું છે",
          "આ રિપોર્ટનો રિપોર્ટની સારાંશ",
          "આ દસ્તાવેજનો દસ્તાવેજની સારાંશ",
          "આ અહેવાલનો અહેવાલની સારાંશ",
          "આ કાગળનો કાગળની સારાંશ",
          "આ દાખલાનો દાખલાની સારાંશ",
          "આ રિપોર્ટનો રિપોર્ટનો અહેવાલ",
          "આ દસ્તાવેજનો દસ્તાવેજનો અહેવાલ",
          "આ અહેવાલનો અહેવાલનો અહેવાલ",
          "આ કાગળનો કાગળનો અહેવાલ",
          "આ દાખલાનો દાખલાનો અહેવાલ",
          "આ રિપોર્ટનો રિપોર્ટની માહિતી",
          "આ દસ્તાવેજનો દસ્તાવેજની માહિતી",
          "આ અહેવાલનો અહેવાલની માહિતી",
          "આ કાગળનો કાગળની માહિતી",
          "આ દાખલાનો દાખલાની માહિતી",
          "આ રિપોર્ટનો રિપોર્ટની વિગત",
          "આ દસ્તાવેજનો દસ્તાવેજની વિગત",
          "આ અહેવાલનો અહેવાલની વિગત",
          "આ કાગળનો કાગળની વિગત",
          "આ દાખલાનો દાખલાની વિગત",
          "આ રિપોર્ટનો રિપોર્ટની વિગતો",
          "આ દસ્તાવેજનો દસ્તાવેજની વિગતો",
          "આ અહેવાલનો અહેવાલની વિગતો",
          "આ કાગળનો કાગળની વિગતો",
          "આ દાખલાનો દાખલાની વિગતો",
          "આ રિપોર્ટનો રિપોર્ટનું પરિણામ",
          "આ દસ્તાવેજનો દસ્તાવેજનું પરિણામ",
          "આ અહેવાલનો અહેવાલનું પરિણામ",
          "આ કાગળનો કાગળનું પરિણામ",
          "આ દાખલાનો દાખલાનું પરિણામ",
          "આ રિપોર્ટનો રિપોર્ટના પરિણામો",
          "આ દસ્તાવેજનો દસ્તાવેજના પરિણામો",
          "આ અહેવાલનો અહેવાલના પરિણામો",
          "આ કાગળનો કાગળના પરિણામો",
          "આ દાખલાનો દાખલાના પરિણામો",
          "આ રિપોર્ટનો રિપોર્ટની ટેસ્ટ",
          "આ દસ્તાવેજનો દસ્તાવેજની ટેસ્ટ",
          "આ અહેવાલનો અહેવાલની ટેસ્ટ",
          "આ કાગળનો કાગળની ટેસ્ટ",
          "આ દાખલાનો દાખલાની ટેસ્ટ",
          "આ રિપોર્ટનો રિપોર્ટના ટેસ્ટ્સ",
          "આ દસ્તાવેજનો દસ્તાવેજના ટેસ્ટ્સ",
          "આ અહેવાલનો અહેવાલના ટેસ્ટ્સ",
          "આ કાગળનો કાગળના ટેસ્ટ્સ",
          "આ દાખલાનો દાખલાના ટેસ્ટ્સ",
          "આ રિપોર્ટનો રિપોર્ટની તપાસ",
          "આ દસ્તાવેજનો દસ્તાવેજની તપાસ",
          "આ અહેવાલનો અહેવાલની તપાસ",
          "આ કાગળનો કાગળની તપાસ",
          "આ દાખલાનો દાખલાની તપાસ",
          "આ રિપોર્ટનો રિપોર્ટનો રિપોર્ટ",
          "આ દસ્તાવેજનો દસ્તાવેજનો રિપોર્ટ",
          "આ અહેવાલનો અહેવાલનો રિપોર્ટ",
          "આ કાગળનો કાગળનો રિપોર્ટ",
          "આ દાખલાનો દાખલાનો રિપોર્ટ",
          "આ રિપોર્ટનો રિપોર્ટનો દસ્તાવેજ",
          "આ દસ્તાવેજનો દસ્તાવેજનો દસ્તાવેજ",
          "આ અહેવાલનો અહેવાલનો દસ્તાવેજ",
          "આ કાગળનો કાગળનો દસ્તાવેજ",
          "આ દાખલાનો દાખલાનો દસ્તાવેજ",
          "આ રિપોર્ટનો રિપોર્ટનો કાગળ",
          "આ દસ્તાવેજનો દસ્તાવેજનો કાગળ",
          "આ અહેવાલનો અહેવાલનો કાગળ",
          "આ કાગળનો કાગળનો કાગળ",
          "આ દાખલાનો દાખલાનો કાગળ",
          "આ રિપોર્ટનો રિપોર્ટનો દાખલો",
          "આ દસ્તાવેજનો દસ્તાવેજનો દાખલો",
          "આ અહેવાલનો અહેવાલનો દાખલો",
          "આ કાગળનો કાગળનો દાખલો",
          "આ દાખલાનો દાખલાનો દાખલો",
          "આ રિપોર્ટનો રિપોર્ટ સારાંશ આપો",
          "આ દસ્તાવેજનો દસ્તાવેજ સારાંશ આપો",
          "આ અહેવાલનો અહેવાલ સારાંશ આપો",
          "આ કાગળનો કાગળ સારાંશ આપો",
          "આ દાખલાનો દાખલો સારાંશ આપો",
          "આ રિપોર્ટનો રિપોર્ટ વિશે કહો",
          "આ દસ્તાવેજનો દસ્તાવેજ વિશે કહો",
          "આ અહેવાલનો અહેવાલ વિશે કહો",
          "આ કાગળનો કાગળ વિશે કહો",
          "આ દાખલાનો દાખલો વિશે કહો",
          "આ રિપોર્ટનો રિપોર્ટ સમજાવો",
          "આ દસ્તાવેજનો દસ્તાવેજ સમજાવો",
          "આ અહેવાલનો અહેવાલ સમજાવો",
          "આ કાગળનો કાગળ સમજાવો",
          "આ દાખલાનો દાખલો સમજાવો",
          "આ રિપોર્ટનો રિપોર્ટ વિશે જણાવો",
          "આ દસ્તાવેજનો દસ્તાવેજ વિશે જણાવો",
          "આ અહેવાલનો અહેવાલ વિશે જણાવો",
          "આ કાગળનો કાગળ વિશે જણાવો",
          "આ દાખલાનો દાખલો વિશે જણાવો",
          "આ રિપોર્ટનો રિપોર્ટમાં શું લખેલું છે",
          "આ દસ્તાવેજનો દસ્તાવેજમાં શું લખેલું છે",
          "આ અહેવાલનો અહેવાલમાં શું લખેલું છે",
          "આ કાગળનો કાગળમાં શું લખેલું છે",
          "આ દાખલાનો દાખલામાં શું લખેલું છે",
          "આ રિપોર્ટનો રિપોર્ટમાં શું છે",
          "આ દસ્તાવેજનો દસ્તાવેજમાં શું છે",
          "આ અહેવાલનો અહેવાલમાં શું છે",
          "આ કાગળનો કાગળમાં શું છે",
          "આ દાખલાનો દાખલામાં શું છે",
          "આ રિપોર્ટનો રિપોર્ટની સારાંશ",
          "આ દસ્તાવેજનો દસ્તાવેજની સારાંશ",
          "આ અહેવાલનો અહેવાલની સારાંશ",
          "આ કાગળનો કાગળની સારાંશ",
          "આ દાખલાનો દાખલાની સારાંશ",
          "આ રિપોર્ટનો રિપોર્ટનો અહેવાલ",
          "આ દસ્તાવેજનો દસ્તાવેજનો અહેવાલ",
          "આ અહેવાલનો અહેવાલનો અહેવાલ",
          "આ કાગળનો કાગળનો અહેવાલ",
          "આ દાખલાનો દાખલાનો અહેવાલ",
          "આ રિપોર્ટનો રિપોર્ટની માહિતી",
          "આ દસ્તાવેજનો દસ્તાવેજની માહિતી",
          "આ અહેવાલનો અહેવાલની માહિતી",
          "આ કાગળનો કાગળની માહિતી",
          "આ દાખલાનો દાખલાની માહિતી",
          "આ રિપોર્ટનો રિપોર્ટની વિગત",
          "આ દસ્તાવેજનો દસ્તાવેજની વિગત",
          "આ અહેવાલનો અહેવાલની વિગત",
          "આ કાગળનો કાગળની વિગત",
          "આ દાખલાનો દાખલાની વિગત",
          "આ રિપોર્ટનો રિપોર્ટની વિગતો",
          "આ દસ્તાવેજનો દસ્તાવેજની વિગતો",
          "આ અહેવાલનો અહેવાલની વિગતો",
          "આ કાગળનો કાગળની વિગતો",
          "આ દાખલાનો દાખલાની વિગતો",
          "આ રિપોર્ટનો રિપોર્ટનું પરિણામ",
          "આ દસ્તાવેજનો દસ્તાવેજનું પરિણામ",
          "આ અહેવાલનો અહેવાલનું પરિણામ",
          "આ કાગળનો કાગળનું પરિણામ",
          "આ દાખલાનો દાખલાનું પરિણામ",
          "આ રિપોર્ટનો રિપોર્ટના પરિણામો",
          "આ દસ્તાવેજનો દસ્તાવેજના પરિણામો",
          "આ અહેવાલનો અહેવાલના પરિણામો",
          "આ કાગળનો કાગળના પરિણામો",
          "આ દાખલાનો દાખલાના પરિણામો",
          "આ રિપોર્ટનો રિપોર્ટની ટેસ્ટ",
          "આ દસ્તાવેજનો દસ્તાવેજની ટેસ્ટ",
          "આ અહેવાલનો અહેવાલની ટેસ્ટ",
          "આ કાગળનો કાગળની ટેસ્ટ",
          "આ દાખલાનો દાખલાની ટેસ્ટ",
          "આ રિપોર્ટનો રિપોર્ટના ટેસ્ટ્સ",
          "આ દસ્તાવેજનો દસ્તાવેજના ટેસ્ટ્સ",
          "આ અહેવાલનો અહેવાલના ટેસ્ટ્સ",
          "આ કાગળનો કાગળના ટેસ્ટ્સ",
          "આ દાખલાનો દાખલાના ટેસ્ટ્સ",
          "આ રિપોર્ટનો રિપોર્ટની તપાસ",
          "આ દસ્તાવેજનો દસ્તાવેજની તપાસ",
          "આ અહેવાલનો અહેવાલની તપાસ",
          "આ કાગળનો કાગળની તપાસ",
          "આ દાખલાનો દાખલાની તપાસ",
          "આ રિપોર્ટનો રિપોર્ટનો રિપોર્ટ",
          "આ દસ્તાવેજનો દસ્તાવેજનો રિપોર્ટ",
          "આ અહેવાલનો અહેવાલનો રિપોર્ટ",
          "આ કાગળનો કાગળનો રિપોર્ટ",
          "આ દાખલાનો દાખલાનો રિપોર્ટ",
          "આ રિપોર્ટનો રિપોર્ટનો દસ્તાવેજ",
          "આ દસ્તાવેજનો દસ્તાવેજનો દસ્તાવેજ",
          "આ અહેવાલનો અહેવાલનો દસ્તાવેજ",
          "આ કાગળનો કાગળનો દસ્તાવેજ",
          "આ દાખલાનો દાખલાનો દસ્તાવેજ",
          "આ રિપોર્ટનો રિપોર્ટનો કાગળ",
          "આ દસ્તાવેજનો દસ્તાવેજનો કાગળ",
          "આ અહેવાલનો અહેવાલનો કાગળ",
          "આ કાગળનો કાગળનો કાગળ",
          "આ દાખલાનો દાખલાનો કાગળ",
          "આ રિપોર્ટનો રિપોર્ટનો દાખલો",
          "આ દસ્તાવેજનો દસ્તાવેજનો દાખલો",
          "આ અહેવાલનો અહેવાલનો દાખલો",
          "આ કાગળનો કાગળનો દાખલો",
          "આ દાખલાનો દાખલાનો દાખલો",
          "रिपोर्ट",
          "दस्तावेज़",
          "सारांश",
          "समझाओ",
          "जानकारी",
          "विवरण",
          "यह रिपोर्ट",
          "यह दस्तावेज़",
          "अहवाल",
          "हा अहवाल",
          "அறிக்கை",
          "சுருக்கம்",
          "விவரங்கள்",
          "இந்த அறிக்கை",
        ];
        if (genericSummaryTokens.includes(stripped)) return true;

        if (authorizedDocs && authorizedDocs.length > 0) {
          const docFileName = (authorizedDocs[0].fileName || "")
            .toLowerCase()
            .replace(/\.[^/.]+$/, "")
            .trim();
          if (
            docFileName &&
            (stripped === docFileName ||
              cleanQuestion === docFileName ||
              cleanQuestion === `@${docFileName}`)
          ) {
            return true;
          }
        }
        return false;
      })();

      const isSingleDocScoped = finalDocumentIds && finalDocumentIds.length === 1;
      const isMultiDocScoped = finalDocumentIds && finalDocumentIds.length > 1;

      const hasSummaryVerb =
        /\b(summary|summarize|overview|saransh|samjhavo|samjhao|samjho|brief|details?|explain)\b/i.test(
          cleanQuestion,
        ) ||
        /સારાંશ|સમજાવો|સમજો|વિગત|વિગતો|માહિતી|સાર|सारांश|समझाओ|विवरण|जानकारी|சுருக்கம்|விவரங்கள்/i.test(
          cleanQuestion,
        ) ||
        /summary\s*(?:aapo|apo|do|dya|kudu)|saransh\s*(?:aapo|apo|do|dya)/i.test(cleanQuestion);

      const hasDocDescriptor =
        /\b(report|document|file|scan|test|results?)\b/i.test(cleanQuestion) ||
        /રિપોર્ટ|દસ્તાવેજ|કાગળ|દાખલો|અહેવાલ|रिपोर्ट|दस्तावेज़|अहवाल|அறிக்கை/i.test(cleanQuestion);

      const hasExplicitCompare =
        /\b(compare|versus|vs|difference\s+between|changes\s+between)\b/i.test(cleanQuestion) ||
        /સરખામણી|તુલના|તફાવત/i.test(cleanQuestion);

      const isSummaryRequest =
        !hasExplicitCompare &&
        (isBareDocumentMention ||
          (isSingleDocScoped && hasSummaryVerb) ||
          (isMultiDocScoped && hasSummaryVerb) ||
          (hasSummaryVerb && hasDocDescriptor) ||
          SUMMARY_KEYWORDS.some((kw) => cleanQuestion.includes(kw)));
      if (isSummaryRequest) {
        return await chatFastPath.handleDocumentSummary(
          {
            userId,
            sessionId,
            question,
            cleanQuestion,
            finalDocumentIds,
            documentId:
              finalDocumentIds && finalDocumentIds.length > 0 ? finalDocumentIds : documentId,
            detectedLanguage,
            patientPreferredLang,
            detectedLanguageMeta,
            p,
            onChunk,
            abortSignal,
            resolvedScopeMode,
            mentions,
          },
          null,
        );
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
              clientTimestamp,
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

          // 2b. DOCUMENT_SUMMARY Handling (Requirement 3 & 4)
          if (medicalIntentMeta.intent === "DOCUMENT_SUMMARY") {
            return await chatFastPath.handleDocumentSummary(
              {
                userId,
                sessionId,
                question,
                cleanQuestion,
                finalDocumentIds,
                documentId:
                  finalDocumentIds && finalDocumentIds.length > 0 ? finalDocumentIds : documentId,
                detectedLanguage,
                patientPreferredLang,
                detectedLanguageMeta,
                p,
                onChunk,
                abortSignal,
                resolvedScopeMode,
                mentions,
              },
              classificationResult,
            );
          }

          // 3. MEDICAL_TREND_CHART Dynamic Generation (REQ-CHART-02, REQ-CHART-05, REQ-CHART-06, REQ-DOC-06)
          let chartMetric = medicalIntentMeta.canonicalMetric || turnSlots.activeMetric;
          const chartScopeDocIds =
            scopeMode === "AUTHORIZED_HISTORY"
              ? null
              : finalDocumentIds && finalDocumentIds.length > 0
                ? finalDocumentIds
                : null;

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
              cleanQuestion,
              detectedLanguage,
              patientPreferredLang,
              detectedLanguageMeta,
              p,
              onChunk,
              abortSignal,
              documentId: finalDocumentIds,
              finalDocumentIds,
              scopeMode: resolvedScopeMode,
              mentions,
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
            clientTimestamp,
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

  // Clear active document scope on a chat session
  async clearSessionScope({ sessionId, userId, clientTimestamp }) {
    const session = await chatSessionRepository.findById(sessionId, userId);
    if (!session) {
      throw new NotFoundException("Chat session not found");
    }

    const currentSlots = session.metadata?.slots || session.metadata?.conversationSlots || {};
    const lastScopeUpdated = currentSlots.scopeUpdatedAt ? Number(currentSlots.scopeUpdatedAt) : 0;

    // Prevent stale scope-clear operations from overriding newer selections
    if (clientTimestamp && lastScopeUpdated && Number(clientTimestamp) < lastScopeUpdated) {
      return {
        cleared: false,
        reason: "STALE_OPERATION",
        scopeMode: currentSlots.scopeMode || "AUTHORIZED_HISTORY",
        activeDocumentIds: currentSlots.activeDocumentIds || [],
        slots: currentSlots,
      };
    }

    const updatedSlots = slotContextService.resolveTurnSlots(currentSlots, {}, {}, [], {
      actionType: "CLEAR_DOCUMENT_SCOPE",
      scopeMode: "AUTHORIZED_HISTORY",
      clientTimestamp: clientTimestamp ? Number(clientTimestamp) : Date.now(),
    });

    await chatSessionRepository.updateSessionMetadata(sessionId, userId, {
      slots: updatedSlots,
      conversationSlots: updatedSlots,
    });

    return {
      cleared: true,
      scopeMode: "AUTHORIZED_HISTORY",
      activeDocumentIds: [],
      slots: updatedSlots,
    };
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
