const { env } = require("../../../configs/env");
const { messageConstants } = require("../../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../../exceptions/appError");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { eq, desc, inArray } = require("drizzle-orm");
const { ollamaClient } = require("../clients/ollamaClient");
const { embeddingService } = require("./embedding.service");
const prompts = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");

const aiClient = require("../clients/aiClient.service");
const { getAgeFromDateOfBirth } = require("../../../helpers/dateHelper");
const { normalizeLanguage } = require("../../../utils/commonUtils");
const { containsEntity } = require("../../../utils/synonyms");

// Debug logger
const debugLogger = {
  // eslint-disable-next-line no-console
  info: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
  // eslint-disable-next-line no-console
  error: (msg, data) => console.error(`[DEBUG ERROR] ${msg}`, JSON.stringify(data, null, 2)),
};

const NO_CONTEXT_REPLY = "Information not found in uploaded reports.";
// const MIN_CITATION_RELEVANCE = 0.7; // cosine similarity ≥ 0.3 distance ≤ 0.7

const NO_CONTEXT_REPLY_I18N = {
  english: "Information not found in uploaded reports.",
  gujarati: "અપલોડ કરેલા અહેવાલોમાં આ માહિતી મળી નથી.",
  hindi: "अपलोड की गई रिपोर्ट में यह जानकारी नहीं मिली।",
  marathi: "अपलोड केलेल्या अहवालात ही माहिती आढळली नाही.",
  tamil: "பதிவேற்றப்பட்ட அறிக்கைகளில் இந்தத் தகவல் காணப்படவில்லை.",
};

const REQUIRE_SELECTION_I18N = {
  english: "Sure, please select your document that you have to compare.",
  gujarati: "ચોક્કસ, કૃપા કરીને તમારો દસ્તાવેજ પસંદ કરો જેની તમારે સરખામણી કરવી છે.",
  hindi: "ज़रूर, कृपया अपने उस दस्तावेज़ का चयन करें जिसकी आपको तुलना करनी है।",
  marathi: "नक्की, कृपया तुमचा दस्तऐवज निवडा ज्याची तुम्हाला तुलना करायची आहे.",
  tamil: "நிச்சயமாக, தயவுசெய்து நீங்கள் ஒப்பிட வேண்டிய உங்கள் ஆவணத்தைத் தேர்ந்தெடுக்கவும்.",
};

const EMERGENCY_WARNING_I18N = {
  english: `This may require urgent medical attention.
Please contact emergency services or visit the nearest emergency department immediately.
The following information is general guidance and not a diagnosis.`,
  gujarati: `આ માટે તાત્કાલિક તબીબી સારવારની જરૂર પડી શકે છે.
કૃપા કરીને તાત્કાલિક કટોકટી સેવાઓનો સંપર્ક કરો અથવા નજીકના કટોકટી વિભાગની મુલાકાત લો.
નીચેની માહિતી સામાન્ય માર્ગદર્શન છે અને કોઈ નિદાન નથી.`,
  hindi: `इसके लिए तत्काल चिकित्सा सहायता की आवश्यकता हो सकती है।
कृपया तुरंत आपातकालीन सेवाओं से संपर्क करें या निकटतम आपातकालीन विभाग में जाएं।
निम्नलिखित जानकारी सामान्य मार्गदर्शन है और कोई निदान नहीं है।`,
  marathi: `यासाठी त्वरित वैद्यकीय लक्ष देण्याची आवश्यकता असू शकते.
कृपया त्वरित आपत्कालीन सेवांशी संपर्क साधा किंवा जवळच्या आपत्कालीन विभागात जा.
खालील माहिती सामान्य मार्गदर्शन आहे आणि निदान नाही.`,
  tamil: `இதற்கு அவசர மருத்துவ உதவி தேவைப்படலாம்.
அவசர சேவைகளைத் தொடர்பு கொள்ளவும் அல்லது உடனடியாக அருகிலுள்ள அவசர சிகிச்சைப் பிரிவுக்குச் செல்லவும்.
பின்வரும் தகவல் பொதுவான வழிகாட்டுதல் மட்டுமே, இது ஒரு நோய் கண்டறிதல் அல்ல.`,
};

const AGE_REPLY_I18N = {
  english: {
    success: (dobStr, age) => `Based on your date of birth (${dobStr}), you are ${age} years old.`,
    missing: "Your date of birth is not specified in your profile, so I cannot calculate your age.",
  },
  gujarati: {
    success: (dobStr, age) => `તમારી જન્મ તારીખ (${dobStr}) ના આધારે, તમારી ઉંમર ${age} વર્ષ છે.`,
    missing:
      "તમારી જન્મ તારીખ તમારી પ્રોફાઇલમાં નિર્દિષ્ટ નથી, તેથી હું તમારી ઉંમરની ગણતરી કરી શકતો નથી.",
  },
  hindi: {
    success: (dobStr, age) => `आपकी जन्म तिथि (${dobStr}) के आधार पर, आपकी आयु ${age} वर्ष है।`,
    missing:
      "आपकी जन्म तिथि आपकी प्रोफ़ाइल में निर्दिष्ट नहीं है, इसलिए मैं आपकी आयु की गणना नहीं कर सकता।",
  },
  marathi: {
    success: (dobStr, age) => `तुमच्या जन्मतारखेनुसार (${dobStr}), तुमचे वय ${age} वर्षे आहे.`,
    missing:
      "तुमची जन्मतारीख तुमच्या प्रोफाइलमध्ये नमूद केलेली नाही, त्यामुळे मी तुमच्या वयाची गणना करू शकत नाही.",
  },
  tamil: {
    success: (dobStr, age) =>
      `உங்கள் பிறந்த தேதியின் (${dobStr}) அடிப்படையில், உங்கள் வயது ${age} ஆண்டுகள் ஆகும்.`,
    missing:
      "உங்கள் பிறந்த தேதி உங்கள் சுயவிவரத்தில் குறிப்பிடப்படவில்லை, எனவே என்னால் உங்கள் வயதைக் கணக்கிடுமாறு செய்ய முடியாது.",
  },
};

const AGE_KEYWORDS = [
  // English
  "what is my age",
  "how old am i",
  "calculate my age",
  // Gujarati
  "મારી ઉંમર શું છે",
  "મારી ઉંમર કેટલી છે",
  "હું કેટલા વર્ષનો છું",
  // Hindi
  "मेरी उम्र क्या है",
  "मेरी आयु क्या है",
  "मैं कितने साल का हूँ",
  // Marathi
  "माझे वय काय आहे",
  "माझे वय किती आहे",
  "मी किती वर्षांचा आहे",
  // Tamil
  "என் வயது என்ன",
  "எனக்கு என்ன வயது",
  "என் வயது எவ்வளவு",
];

const processingSessions = new Set();

function getMedicalEntityKeywords(question) {
  if (!question) return [];
  const entities = [
    { key: "hemoglobin", regex: /hemoglobin|haemoglobin|hb|hgb/i },
    { key: "glucose", regex: /glucose|blood sugar|sugar|hba1c/i },
    { key: "rbc", regex: /rbc|red blood cell/i },
    { key: "wbc", regex: /wbc|white blood cell/i },
    { key: "platelets", regex: /platelets?/i },
    { key: "creatinine", regex: /creatinine/i },
    { key: "cholesterol", regex: /cholesterol|lipid/i },
    { key: "vitamin d", regex: /vitamin d|vit d/i },
    { key: "tsh", regex: /tsh|thyroid/i },
  ];
  const found = [];
  for (const entity of entities) {
    if (entity.regex.test(question)) {
      found.push(entity.key);
    }
  }
  return found;
}

class ChatService {
  detectEmergency(text) {
    const cleanText = String(text || "").toLowerCase();
    return prompts.EMERGENCY_KEYWORDS.some((keyword) => cleanText.includes(keyword));
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

      const contextText = Array.from(chunksByDoc.entries())
        .map(([chunks]) => {
          const docData = chunks[0].docData || {};
          let pName = "Unknown";
          if (docData.structuredExtractedData?.patient?.name) {
            pName = docData.structuredExtractedData.patient.name;
          }
          const fileName = docData.fileName || "Unknown";
          const reportDate = docData.reportDate
            ? new Date(docData.reportDate).toISOString().split("T")[0]
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
Patient: ${pName}

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
      const instructionContent =
        prompts.STRICT_LANGUAGE_INSTRUCTIONS[normLang] ||
        prompts.STRICT_LANGUAGE_INSTRUCTIONS.english;
      systemPrompt += `\n\n${instructionContent}`;
      const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

      // eslint-disable-next-line no-console
      console.log(
        `[ChatService] Running local RAG chat (generation in ${normLang}) using ${env.chatModel}...`,
      );

      let answer = "";
      if (onChunk) {
        //streming mode
        await ollamaClient.chatStream(
          formattedMessages,
          env.chatModel,
          (chunk) => {
            answer += chunk; //save in local variable for final return
            onChunk(chunk); //pass to frontend for streaming
          },
          {
            temperature: 0.2,
            maxTokens: 1024,
            rawOptions: { num_ctx: 8192 },
            signal: abortSignal,
          },
        );
      } else {
        answer = await ollamaClient.chat(formattedMessages, env.chatModel, {
          temperature: 0.2,
          maxTokens: 1024,
          rawOptions: { num_ctx: 8192 },
          signal: abortSignal,
        });
      }

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

    const instructionContent =
      prompts.STRICT_LANGUAGE_INSTRUCTIONS[normLang] ||
      prompts.STRICT_LANGUAGE_INSTRUCTIONS.english;
    systemPrompt += `\n\n${instructionContent}`;
    const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

    // eslint-disable-next-line no-console
    console.log(
      `[ChatService] Running local general chat (generation in ${normLang}) using ${env.chatModel}...`,
    );

    let answer = "";
    if (onChunk) {
      await ollamaClient.chatStream(
        formattedMessages,
        env.chatModel,
        (chunk) => {
          answer += chunk;
          onChunk(chunk);
        },
        {
          temperature: 0.2,
          maxTokens: 2048,
          rawOptions: { num_ctx: 16384 },
          signal: abortSignal,
        },
      );
    } else {
      answer = await ollamaClient.chat(formattedMessages, env.chatModel, {
        temperature: 0.2,
        maxTokens: 2048,
        rawOptions: { num_ctx: 16384 },
        signal: abortSignal,
      });
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
    return chatSessionRepository.listMessages({ cursor, direction, limit, sessionId, userId });
  }

  async sendMessage({
    userId,
    documentId,
    question,
    sessionId: reqSessionId,
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

      // Resolve and normalize preferred language
      let preferredLanguage = "english";
      const p = await patientRepository.findById(userId);
      if (p) {
        preferredLanguage = p.preferredLanguage || "english";
      }
      if (!preferredLanguage || preferredLanguage === "english") {
        try {
          const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");
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
      preferredLanguage = normalizeLanguage(preferredLanguage);

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
      preferredLanguage = detectedLanguage;
      const retrievalQuery = question;

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
      const sessionId = session.id;

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
            if (
              intent === "COMPARE" &&
              !retrievalQuery
                .toLowerCase()
                .replace(/[^a-z0-9]/g, " ")
                .split(/\\s+/)
                .filter((w) => w.length > 0)
                .some(
                  (w) =>
                    !compareKeywords.includes(w) &&
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
              const userMsg = await chatSessionRepository.appendMessage({
                content: question.trim(),
                role: "user",
                sessionId,
                userId,
              });
              const replyText =
                REQUIRE_SELECTION_I18N[detectedLanguage] || REQUIRE_SELECTION_I18N.english;
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
            finalDocumentIds = recentDocs.map((d) => d.id);
          } else if (recentDocs.length === 1) {
            finalDocumentIds = [recentDocs[0].id];
            documentScope = "SINGLE_DOCUMENT";
          } else {
            // Intent is DOCUMENT, trying to find which one
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

      let assistantText = NO_CONTEXT_REPLY;
      let isEmergency = false;
      let mode = intent === "GENERAL" ? "GENERAL_HEALTH" : "DOCUMENT_RAG";

      // Build patient context
      let patientContextStr = "";
      if (p) {
        let dobStr = p.dateOfBirth
          ? p.dateOfBirth instanceof Date
            ? p.dateOfBirth.toISOString().split("T")[0]
            : String(p.dateOfBirth).split("T")[0]
          : "Unknown";
        const allergiesStr =
          p.allergies && Array.isArray(p.allergies) && p.allergies.length > 0
            ? p.allergies.join(", ")
            : "None";
        patientContextStr = `Patient Profile Context:\nName: ${p.firstName || ""} ${p.lastName || ""}\nGender: ${p.gender || "Unknown"}\nDate of Birth: ${dobStr}\nBlood Group: ${p.bloodGroup || "Unknown"}\nAllergies: ${allergiesStr}\nIMPORTANT INSTRUCTION: Use the above profile information ONLY to answer the user's specific question.`;
      }

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
        } catch {
          assistantText =
            detectedLanguage === "english"
              ? "Sorry, I am currently unable to process your request."
              : "Sorry, error occurred.";
        }
      } else {
        // DATA RETRIEVER (Vector Search)
        let summaryChunks = [];
        let coverageStr = "";
        try {
          const retrieveStartTime = Date.now();
          const lowerQ = retrievalQuery.toLowerCase();

          let detectedSectionType = null;
          if (
            lowerQ.includes("summary") ||
            lowerQ.includes("overview") ||
            documentScope === "FULL_DOCUMENT"
          ) {
            detectedSectionType = "summary";
          }

          const medicalEntities = getMedicalEntityKeywords(lowerQ);
          const queryEmbedding = await embeddingService.embedText(retrievalQuery);

          let relevantChunks = [];
          const entitiesFoundPerDoc = new Map();

          if (finalDocumentIds && finalDocumentIds.length > 0) {
            finalDocumentIds.forEach((id) => entitiesFoundPerDoc.set(String(id), new Set()));

            if (documentScope === "FULL_DOCUMENT" && finalDocumentIds.length === 1) {
              const structuredDoc = await intelligenceRepository.findStructuredDocumentByDocumentId(
                finalDocumentIds[0],
                userId,
              );
              if (structuredDoc && structuredDoc.rawText) {
                summaryChunks = [
                  {
                    chunkId: "full-doc",
                    documentId: finalDocumentIds[0],
                    sectionTitle: "Complete Document",
                    content: structuredDoc.rawText.substring(0, 40000),
                    sourceType: "rawText",
                    docData: docNameMap[finalDocumentIds[0]] || {},
                  },
                ];
                debugLogger.info(
                  `sendMessage: [SCOPE] ${JSON.stringify({ detectedLanguage, intent, documentScope, requestedDocumentCount: 1 })}`,
                );
                debugLogger.info(
                  `sendMessage: [RETRIEVAL] Fetched full document raw text directly.`,
                );
              }
            }

            if (summaryChunks.length === 0) {
              // PARALLEL RETRIEVAL (Per Document + Per Entity)
              const queryPromises = [];

              for (const dId of finalDocumentIds) {
                if (medicalEntities.length > 0) {
                  for (const entity of medicalEntities) {
                    queryPromises.push(
                      (async () => {
                        try {
                          const chunks = await intelligenceRepository.searchSimilarChunks({
                            userId,
                            queryEmbedding,
                            limit: 10,
                            documentIds: [dId],
                            keywords: [entity],
                          });
                          return { dId, entity, chunks, success: true };
                        } catch (err) {
                          debugLogger.error(
                            `Failed to retrieve chunks for doc ${dId} and entity ${entity}`,
                            {
                              error: err.message,
                            },
                          );
                          return { dId, entity, chunks: [], success: false };
                        }
                      })(),
                    );
                  }
                } else {
                  queryPromises.push(
                    (async () => {
                      try {
                        const chunks = await intelligenceRepository.searchSimilarChunks({
                          userId,
                          queryEmbedding,
                          limit: 20,
                          documentIds: [dId],
                        });
                        return { dId, entity: null, chunks, success: true };
                      } catch (err) {
                        console.log("err", err);
                        return { dId, entity: null, chunks: [], success: false };
                      }
                    })(),
                  );
                }
              }

              const queryResults = await Promise.all(queryPromises);

              // Track retrieval status and calculate detailed statuses
              let retrievedCount = 0;
              const retrievedDocs = new Set();
              for (const r of queryResults) {
                if (r.success && r.chunks.length > 0) {
                  retrievedDocs.add(String(r.dId));
                }
                relevantChunks.push(...r.chunks);
              }
              retrievedCount = retrievedDocs.size;

              const entityStatusPerDoc = new Map(); // Key: `${docIdStr}_${entity}`, Value: 'FOUND' | 'NOT_FOUND_VERIFIED' | 'NOT_VERIFIED'

              for (const dId of finalDocumentIds) {
                const docIdStr = String(dId);
                const docData = docNameMap[dId] || {};

                for (const entity of medicalEntities) {
                  const statusKey = `${docIdStr}_${entity}`;
                  const qRes = queryResults.find(
                    (r) => String(r.dId) === docIdStr && r.entity === entity,
                  );

                  if (!qRes || !qRes.success) {
                    entityStatusPerDoc.set(statusKey, "NOT_VERIFIED");
                    continue;
                  }

                  const foundInChunks = qRes.chunks.some((c) => containsEntity(c.content, entity));
                  let foundInSummary = false;
                  if (
                    docData.structuredExtractedData?.tests &&
                    Array.isArray(docData.structuredExtractedData.tests)
                  ) {
                    foundInSummary = docData.structuredExtractedData.tests.some((t) => {
                      const testNameLower = t.name?.toLowerCase() || "";
                      return containsEntity(testNameLower, entity);
                    });
                  }

                  if (foundInChunks || foundInSummary) {
                    entityStatusPerDoc.set(statusKey, "FOUND");
                    entitiesFoundPerDoc.get(docIdStr).add(entity);
                  } else {
                    entityStatusPerDoc.set(statusKey, "NOT_FOUND_VERIFIED");
                  }
                }
              }

              // 1. Deduplicate by chunkId + documentId to preserve same-text chunks across different docs
              const uniqueChunks = [];
              const seenChunks = new Set();
              for (const c of relevantChunks) {
                const chunkKey = `${c.documentId}_${c.chunkId}`;
                if (!seenChunks.has(chunkKey)) {
                  seenChunks.add(chunkKey);
                  uniqueChunks.push(c);
                }
              }

              // 2. Summary Preference
              let filteredChunks = uniqueChunks;
              if (detectedSectionType === "summary") {
                const docsWithSummary = new Set(
                  uniqueChunks
                    .filter((c) => c.sourceType === "summary")
                    .map((c) => String(c.documentId)),
                );
                filteredChunks = uniqueChunks.filter((c) => {
                  if (c.sourceType === "ocr" && docsWithSummary.has(String(c.documentId)))
                    return false;
                  return true;
                });
              }

              // 3. Selection Algorithm (Coverage-Aware)
              const chunksPerDoc = new Map();
              const finalSelection = [];

              // Sort globally first
              filteredChunks.sort((a, b) => (a.distance || 0) - (b.distance || 0));

              // Pass 1: Prioritize exact medical entity matches
              for (const c of filteredChunks) {
                const docIdStr = String(c.documentId);
                let hasEntity = false;

                for (const entity of medicalEntities) {
                  if (containsEntity(c.content, entity)) {
                    entitiesFoundPerDoc.get(docIdStr).add(entity);
                    hasEntity = true;
                  }
                }

                const count = chunksPerDoc.get(docIdStr) || 0;
                if (hasEntity && count < 4) {
                  if (!finalSelection.includes(c)) {
                    finalSelection.push(c);
                    chunksPerDoc.set(docIdStr, count + 1);
                  }
                }
              }

              // Pass 2: Fill remaining up to MAX_CONTEXT_CHUNKS (25)
              const MAX_CONTEXT_CHUNKS = 25;
              for (const c of filteredChunks) {
                if (finalSelection.length >= MAX_CONTEXT_CHUNKS) break;
                const docIdStr = String(c.documentId);
                const count = chunksPerDoc.get(docIdStr) || 0;

                if (count < 6 && !finalSelection.includes(c)) {
                  finalSelection.push(c);
                  chunksPerDoc.set(docIdStr, count + 1);
                }
              }

              summaryChunks = finalSelection.map((c, index) => {
                const docData = docNameMap[c.documentId] || {};
                return {
                  chunkId: c.chunkId || `chunk-${index}`,
                  documentId: c.documentId,
                  sectionTitle: c.sectionTitle,
                  content: c.content,
                  score: 1.0,
                  sourceType: c.sourceType || "document",
                  docData: docData,
                };
              });

              // Structured Logging
              const coverageObj = {};
              finalDocumentIds.forEach((id) => {
                coverageObj[id] = Array.from(entitiesFoundPerDoc.get(String(id)) || []);
              });
              const chunksPerDocLog = Object.fromEntries(chunksPerDoc);

              debugLogger.info(
                `sendMessage: [SCOPE] ${JSON.stringify({ detectedLanguage, intent, documentScope, requestedDocumentCount: finalDocumentIds.length })}`,
              );
              debugLogger.info(
                `sendMessage: [RETRIEVAL] ${JSON.stringify({ query: retrievalQuery, entities: medicalEntities, retrievedChunkCount: relevantChunks.length, duration: Date.now() - retrieveStartTime })}`,
              );
              debugLogger.info(
                `sendMessage: [COVERAGE] ${JSON.stringify({ requestedDocuments: finalDocumentIds.length, retrievedDocuments: retrievedCount, missingDocuments: finalDocumentIds.length - retrievedCount, entitiesFound: coverageObj })}`,
              );
              debugLogger.info(
                `sendMessage: [SELECTION] ${JSON.stringify({ selectedChunks: summaryChunks.length, chunksPerDocument: chunksPerDocLog })}`,
              );

              // Build coverage string for Qwen
              if (medicalEntities.length > 0) {
                coverageStr = finalDocumentIds
                  .map((id) => {
                    const docIdStr = String(id);
                    let docLabel = `Document ${id}`;
                    if (docNameMap[id]) docLabel = docNameMap[id].fileName || docLabel;

                    const entityStatuses = medicalEntities.map((entity) => {
                      const statusKey = `${docIdStr}_${entity}`;
                      const status = entityStatusPerDoc.get(statusKey) || "NOT_VERIFIED";
                      return `${entity.toUpperCase()}: ${status}`;
                    });

                    return `${docLabel}: [${entityStatuses.join(", ")}]`;
                  })
                  .join("\n");
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
          } catch {
            assistantText =
              NO_CONTEXT_REPLY_I18N[detectedLanguage] || NO_CONTEXT_REPLY_I18N.english;
          }
        }
      }

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
};
