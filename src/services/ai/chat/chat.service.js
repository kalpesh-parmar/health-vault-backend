const { env } = require("../../../configs/env");
const { messageConstants } = require("../../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../../exceptions/appError");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
// const { chatSession } = require("../../../models/chatSession");
const { eq, desc } = require("drizzle-orm");

// const { ocrOrchestrator } = require("../ocr/ocr.orchestrator");
// const { ocrService } = require("../ocr/ocr.service");
// const documentPersistenceService = require("../../documentPersistenceService");
const { ollamaClient } = require("../clients/ollamaClient");
// const aiClient = require("../clients/aiClient.service");
const { embeddingService } = require("./embedding.service");
const prompts = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const { getAgeFromDateOfBirth } = require("../../../helpers/dateHelper");
const { normalizeLanguage } = require("../../../utils/commonUtils");

// Debug logger
const debugLogger = {
  info: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
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

// function relevance(distance) {
//   if (distance == null) return null;
//   return Math.max(0, Math.min(1, 1 - Number(distance)));
// }

// function isTextInLanguage(text, language) {
//   if (!text || !language) return false;
//   const lang = language.toLowerCase();
//   if (lang === "gujarati") {
//     return /[\u0A80-\u0AFF]/.test(text);
//   }
//   if (lang === "hindi" || lang === "marathi") {
//     return /[\u0900-\u097F]/.test(text);
//   }
//   if (lang === "tamil") {
//     return /[\u0B80-\u0BFF]/.test(text);
//   }
//   if (lang === "english") {
//     return !/[\u0A80-\u0AFF\u0900-\u097F\u0B80-\u0BFF]/.test(text);
//   }
//   return false;
// }

const processingSessions = new Set();

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

      const contextText = contextChunks
        .map((c) => `[${c.sectionTitle || "Report Content"}]\nContent: ${c.content}`)
        .join("\n\n");

      let systemPrompt = prompts.RAG_PROMPT_TEMPLATE(contextText, normLang);
      if (patientContextStr) {
        systemPrompt += `\n\n${patientContextStr}`;
      }
      systemPrompt += `\n\nCRITICAL INSTRUCTION: Keep your answer highly concise (under 200 tokens).`;
      const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];
      if (normLang === "english") {
        formattedMessages.push({
          role: "system",
          content:
            "CRITICAL INSTRUCTION: You MUST generate your entire response in English ONLY. Do NOT use the language of the previous messages.",
        });
      }

      console.log(`[ChatService] Running local RAG chat in ${normLang} using ${env.chatModel}...`);
      const answer = await ollamaClient.chat(formattedMessages, env.chatModel, {
        temperature: 0.2,
        maxTokens: 2048,
        rawOptions: { num_ctx: 16384 },
      });
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

    const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];
    if (normLang === "english") {
      formattedMessages.push({
        role: "system",
        content:
          "CRITICAL INSTRUCTION: You MUST generate your entire response in English ONLY. Do NOT use the language of the previous messages.",
      });
    }

    console.log(
      `[ChatService] Running local general chat in ${normLang} using ${env.chatModel}...`,
    );
    const answer = await ollamaClient.chat(formattedMessages, env.chatModel, {
      temperature: 0.2,
      maxTokens: 2048,
      rawOptions: { num_ctx: 16384 },
    });
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

  async sendMessage({ userId, documentId, question, sessionId: reqSessionId }) {
    if (reqSessionId) {
      if (processingSessions.has(reqSessionId)) {
        throw new InvalidRequestException(
          "A message is already being processed for this session. Please wait.",
        );
      }
      processingSessions.add(reqSessionId);
    }

    try {
      const _reqStartTime = Date.now();
      debugLogger.info("sendMessage: Incoming payload", {
        userId,
        documentId,
        reqSessionId,
        question: question?.substring(0, 100),
      });

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
          debugLogger.error("sendMessage: Failed to read onboarding fallback language", {
            error: err.message,
          });
        }
      }
      preferredLanguage = normalizeLanguage(preferredLanguage);

      // Intercept specific questions
      const cleanQuestion = question.toLowerCase().replace(/[?.]/g, "").trim();
      let interceptedReply = null;

      let englishQuestion = question;
      // if (preferredLanguage !== "english" && !isTextInLanguage(question, "english")) {
      //   try {
      //     debugLogger.info("sendMessage: [LLM TRACKING] [1] Translating incoming question (IndicTrans2)");
      //     const inTransStartTime = Date.now();
      //     englishQuestion = await aiClient.translate(question, preferredLanguage, "english");
      //     const inTransDuration = Date.now() - inTransStartTime;
      //     debugLogger.info(`sendMessage: [PERFORMANCE] Input IndicTrans2 Translation took ${inTransDuration}ms`);
      //     debugLogger.info("sendMessage: Translated question to English for internal processing", { original: question, english: englishQuestion });
      //   } catch (err) {
      //     debugLogger.error("sendMessage: Failed to translate question to English", { error: err.message });
      //   }
      // }

      if (AGE_KEYWORDS.includes(cleanQuestion)) {
        debugLogger.info("sendMessage: Intercepted age-related question", { question });
        const ageTemplates = AGE_REPLY_I18N[preferredLanguage] || AGE_REPLY_I18N.english;
        if (p && p.dateOfBirth) {
          let dobStr = p.dateOfBirth;
          if (p.dateOfBirth instanceof Date) {
            dobStr = p.dateOfBirth.toISOString().split("T")[0];
          } else if (typeof p.dateOfBirth === "string") {
            dobStr = p.dateOfBirth.split("T")[0];
          }
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
        session = await chatSessionRepository.createSession({
          userId,
          title: "Health Chat",
          metadata: { active_document_ids: documentId || [] },
        });
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
          metadata: {
            mode: "GENERAL_HEALTH",
            emergency: false,
            intercepted: true,
            documentId: [],
          },
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
      const intentStartTime = Date.now();
      if (documentId && documentId.length > 0) {
        intent = documentId.length > 1 ? "COMPARE" : "DOCUMENT";
        debugLogger.info(
          `sendMessage: [PERFORMANCE] Intent Analyzer (Pre-selected) took ${Date.now() - intentStartTime}ms`,
        );
      } else {
        const lowerQuestion = englishQuestion.toLowerCase();

        // Fast deterministic rule-matching
        const generalKeywords = [
          "hi ",
          "hello",
          "hey ",
          "how are you",
          "tips",
          "diet",
          "advice",
          "fever",
          "cough",
          "headache",
          "general",
          "who are you",
        ];
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
          "this",
          "my",
          "first",
          "second",
          "last",
          "latest",
          "recent",
          "sugar",
          "blood",
          "vitamin",
        ];

        const hasCompare = compareKeywords.some((kw) => lowerQuestion.includes(kw));
        const hasDocument = documentKeywords.some((kw) => lowerQuestion.includes(kw));

        if (hasCompare && hasDocument) {
          intent = "COMPARE";
        } else if (hasCompare && lowerQuestion.includes("report")) {
          intent = "COMPARE";
        } else if (hasDocument) {
          if (lowerQuestion.includes("reports")) {
            intent = "COMPARE";
          } else {
            intent = "DOCUMENT";
          }
        } else {
          const isGeneral = generalKeywords.some((kw) => lowerQuestion.includes(kw));
          if (!isGeneral) {
            // Fallback to LLM if ambiguous
            const analyzerPrompt = `Analyze the user's question: "${englishQuestion}"
Classify the intent strictly into one of these three categories:
1. GENERAL: User is asking about their general health, profile, age, symptoms, general advice WITHOUT mentioning their reports.
2. DOCUMENT: User is asking about a specific medical report, lab result, recent upload, or specific remedies/advice based on a specific report.
3. COMPARE: User is asking to compare multiple reports, find trends, asks for an overview/summary of ALL reports, asks to find specific values (high/low/abnormal) across reports, or asks for remedies/advice based on all reports.
Return ONLY the exact word GENERAL, DOCUMENT, or COMPARE. No other text.`;
            try {
              debugLogger.info("sendMessage: [LLM TRACKING] [2] Calling Request Analyzer (Qwen)");
              const analyzerRes = await ollamaClient.generate(analyzerPrompt, env.chatModel, {
                temperature: 0,
                maxTokens: 10,
              });
              const resClean = analyzerRes.toUpperCase().trim();
              if (resClean.includes("COMPARE")) intent = "COMPARE";
              else if (resClean.includes("DOCUMENT")) intent = "DOCUMENT";
              else intent = "GENERAL";
            } catch (err) {
              debugLogger.error("sendMessage: Request Analyzer failed", { error: err.message });
            }
          }
        }
        debugLogger.info(
          `sendMessage: [PERFORMANCE] Intent Analyzer took ${Date.now() - intentStartTime}ms`,
          { intent },
        );
      }

      let finalDocumentIds = [];
      if (intent === "DOCUMENT" || intent === "COMPARE") {
        if (documentId && documentId.length > 0) {
          debugLogger.info("sendMessage: Document(s) explicitly passed by user", { documentId });
          finalDocumentIds = documentId;
        } else {
          // Resolve documents using uploads
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
            debugLogger.info(
              "sendMessage: No recent documents found, falling back to GENERAL intent",
            );
            intent = "GENERAL"; // fallback
          } else if (recentDocs.length === 1) {
            debugLogger.info(
              "sendMessage: Only one recent document available, selecting it automatically",
              { documentId: recentDocs[0].id },
            );
            finalDocumentIds = [recentDocs[0].id];
          } else {
            const resolverStartTime = Date.now();
            const lowerQuestion = englishQuestion.toLowerCase();
            let resolvedIds = null;

            if (lowerQuestion.includes("all") || lowerQuestion.includes("every")) {
              resolvedIds = recentDocs.map((d) => d.id);
            } else if (lowerQuestion.includes("first") || lowerQuestion.includes("oldest")) {
              resolvedIds = [recentDocs[recentDocs.length - 1].id];
            } else if (
              lowerQuestion.includes("last") ||
              lowerQuestion.includes("latest") ||
              lowerQuestion.includes("recent")
            ) {
              resolvedIds = [recentDocs[0].id];
            } else {
              const matchedDocs = recentDocs.filter(
                (d) =>
                  (d.fileName &&
                    lowerQuestion.includes(d.fileName.toLowerCase().replace(".pdf", "").trim())) ||
                  (d.documentType &&
                    lowerQuestion.includes(d.documentType.toLowerCase().replace("_", " "))),
              );
              if (matchedDocs.length > 0) {
                resolvedIds = matchedDocs.map((d) => d.id);
              } else if (
                intent === "COMPARE" ||
                lowerQuestion.includes("medicine") ||
                lowerQuestion.includes("medication") ||
                lowerQuestion.includes("pill") ||
                lowerQuestion.includes("dosage") ||
                lowerQuestion.includes("prescribe")
              ) {
                if (
                  lowerQuestion.includes("high") ||
                  lowerQuestion.includes("low") ||
                  lowerQuestion.includes("abnormal") ||
                  lowerQuestion.includes("value") ||
                  lowerQuestion.includes("which") ||
                  lowerQuestion.includes("medication") ||
                  lowerQuestion.includes("medicine") ||
                  lowerQuestion.includes("pill") ||
                  lowerQuestion.includes("dosage") ||
                  lowerQuestion.includes("prescribe") ||
                  lowerQuestion.includes("drug")
                ) {
                  resolvedIds = recentDocs.map((d) => d.id);
                }
              }
            }

            if (resolvedIds) {
              finalDocumentIds = resolvedIds;
              debugLogger.info(
                `sendMessage: [PERFORMANCE] Document Resolver (Rules) took ${Date.now() - resolverStartTime}ms`,
                { finalDocumentIds },
              );
            } else {
              debugLogger.info(
                "sendMessage: Multiple recent documents found, invoking Document Resolver LLM",
              );
              const docsListStr = recentDocs
                .map(
                  (d, i) =>
                    `${i + 1}. ID: ${d.id} | Name: ${d.fileName} | Type: ${d.documentType} | Date: ${d.createdAt.toISOString().split("T")[0]}`,
                )
                .join("\n");

              const resolvePrompt = `User asks: "${englishQuestion}"
Available documents:
${docsListStr}

Which document IDs match this request?
- If the user asks for "all" reports, an overview of all reports, or a summary of all reports, return a JSON array with ALL the available document IDs.
- If the user asks a question that requires searching for a particular value, remedies, or searching across multiple/all reports (e.g., "which report has high sugar", "what is low", "remedies for my condition"), return a JSON array with ALL the available document IDs so the AI can search them.
- If the user asks for a sequence:
  - "first" or "oldest" means the chronologically OLDEST report (the one with the oldest Date, usually at the bottom of the list).
  - "last", "latest", or "recent" means the chronologically NEWEST report (the one with the most recent Date, usually #1).
  - For "second", "third", etc., map it logically based on the Dates.
  Return a JSON array with the exact matched ID.
- If the user explicitly names a file (e.g., matching the Name like "blood_test.pdf") or document type (e.g., "X-Ray", "MRI", "Prescription"), return a JSON array with those specific IDs.
- CRITICAL: If the user simply asks to "compare reports" without naming exactly WHICH reports to compare, and does not mention "all", you MUST output the exact word "AMBIGUOUS" and nothing else.
- If the request is too vague to definitively pick specific documents and doesn't fall into the above, output "AMBIGUOUS".
Return ONLY a valid JSON array of IDs like ["id1", "id2"], OR the exact string "AMBIGUOUS".`;

              try {
                const resolveRes = await ollamaClient.generate(resolvePrompt, env.chatModel, {
                  temperature: 0,
                  maxTokens: 150,
                });
                const resClean = resolveRes.trim();
                if (resClean.includes("AMBIGUOUS")) {
                  debugLogger.info(
                    "sendMessage: Document Resolver found query ambiguous, returning requireSelection",
                    { availableReportsCount: recentDocs.length },
                  );

                  const userMsg = await chatSessionRepository.appendMessage({
                    content: question.trim(),
                    role: "user",
                    sessionId,
                    userId,
                  });

                  const replyText =
                    REQUIRE_SELECTION_I18N[preferredLanguage] || REQUIRE_SELECTION_I18N.english;

                  const aiMsg = await chatSessionRepository.appendMessage({
                    citations: [],
                    content: replyText,
                    metadata: {
                      mode: "DOCUMENT_RAG",
                      emergency: false,
                      requireSelection: true,
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
                    requireSelection: true,
                    reports: recentDocs,
                    mode: "DOCUMENT_RAG",
                    emergency: false,
                  };
                } else {
                  const jsonMatch = resClean.match(/\[.*\]/s);
                  if (jsonMatch) {
                    const parsedIds = JSON.parse(jsonMatch[0]);
                    finalDocumentIds = parsedIds.filter((id) =>
                      recentDocs.some((rd) => rd.id === id),
                    );
                    debugLogger.info(
                      "sendMessage: Document Resolver selected documents based on query",
                      { finalDocumentIds },
                    );
                  }
                  if (finalDocumentIds.length === 0) {
                    finalDocumentIds = [recentDocs[0].id]; // fallback to latest
                    debugLogger.info(
                      "sendMessage: Document Resolver returned no matches, falling back to latest document",
                      { finalDocumentIds },
                    );
                  }
                }
                debugLogger.info(
                  `sendMessage: [PERFORMANCE] Document Resolver (LLM) took ${Date.now() - resolverStartTime}ms`,
                );
              } catch (e) {
                finalDocumentIds = [recentDocs[0].id]; // fallback to latest on error
                debugLogger.info(
                  "sendMessage: Document Resolver failed, falling back to latest document",
                  { finalDocumentIds, error: e.message },
                );
              }
            }
          }
        }
      }

      const userMessage = await chatSessionRepository.appendMessage({
        content: question.trim(),
        role: "user",
        sessionId,
        userId,
      });

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
            preferredLanguage,
          );
          const qwenDuration = Date.now() - qwenStartTime;
          debugLogger.info(`sendMessage: [PERFORMANCE] Qwen LLM Generation took ${qwenDuration}ms`);

          let rawAns = aiResponse.answer;
          // if (preferredLanguage !== "english" && !isTextInLanguage(rawAns, preferredLanguage)) {
          //   debugLogger.info("sendMessage: [LLM TRACKING] [5] Translating final answer (IndicTrans2)");
          //   const transStartTime = Date.now();
          //   rawAns = await aiClient.translate(rawAns, "english", preferredLanguage);
          //   const transDuration = Date.now() - transStartTime;
          //   debugLogger.info(`sendMessage: [PERFORMANCE] IndicTrans2 Translation took ${transDuration}ms`);
          // }
          assistantText = rawAns;
          isEmergency = !!aiResponse.emergency;
        } catch {
          assistantText =
            preferredLanguage === "english"
              ? "Sorry, I am currently unable to process your request."
              : "Sorry, error occurred.";
        }
      } else {
        // DATA RETRIEVER (Vector Search)
        debugLogger.info(
          "sendMessage: Data Retriever fetching relevant chunks for selected documents",
          { finalDocumentIds },
        );
        let summaryChunks = [];
        try {
          const retrieveStartTime = Date.now();

          const lowerQ = englishQuestion.toLowerCase();
          let detectedSectionType = null;
          let detectedKeyword = null;

          if (
            lowerQ.includes("medicine") ||
            lowerQ.includes("medication") ||
            lowerQ.includes("pill") ||
            lowerQ.includes("tablet") ||
            lowerQ.includes("dosage") ||
            lowerQ.includes("prescribe") ||
            lowerQ.includes("drug")
          ) {
            detectedSectionType = "medication";
          } else if (
            lowerQ.includes("sugar") ||
            lowerQ.includes("blood") ||
            lowerQ.includes("level") ||
            lowerQ.includes("test") ||
            lowerQ.includes("lab") ||
            lowerQ.includes("vitamin")
          ) {
            detectedSectionType = "lab_test";
          } else if (
            lowerQ.includes("diagnosis") ||
            lowerQ.includes("disease") ||
            lowerQ.includes("condition")
          ) {
            detectedSectionType = "observation";
          } else if (lowerQ.includes("summary") || lowerQ.includes("overview")) {
            detectedSectionType = "summary";
          }

          const queryEmbedding = await embeddingService.embedText(englishQuestion);
          const relevantChunks = await intelligenceRepository.searchSimilarChunks({
            userId,
            queryEmbedding,
            limit: 8,
            documentIds: finalDocumentIds,
            sectionType: detectedSectionType,
            keyword: detectedKeyword,
          });

          summaryChunks = relevantChunks.map((c, index) => {
            return {
              chunkId: c.chunkId || `chunk-${index}`,
              documentId: c.documentId,
              sectionTitle: c.sectionTitle || `[Report Chunk ${index + 1}]`,
              content: c.content,
              score: 1.0,
              sourceType: c.sourceType || "document",
            };
          });

          debugLogger.info(
            `sendMessage: [PERFORMANCE] Vector Search Retrieval took ${Date.now() - retrieveStartTime}ms. Retrieved ${summaryChunks.length} chunks.`,
          );
        } catch (err) {
          debugLogger.error("sendMessage: Failed to fetch chunks via vector search", {
            error: err.message,
          });
        }

        if (!summaryChunks.length) {
          assistantText = NO_CONTEXT_REPLY_I18N[preferredLanguage] || NO_CONTEXT_REPLY_I18N.english;
        } else {
          try {
            // One Call
            debugLogger.info(
              "sendMessage: [LLM TRACKING] [4] Calling Final Chat for DOCUMENT_RAG (Qwen)",
            );
            const qwenStartTime = Date.now();
            const aiResponse = await this.qwenHealthChat(
              history,
              "DOCUMENT_RAG",
              summaryChunks,
              patientContextStr,
              preferredLanguage,
            );
            const qwenDuration = Date.now() - qwenStartTime;
            debugLogger.info(
              `sendMessage: [PERFORMANCE] Qwen LLM Generation took ${qwenDuration}ms`,
            );

            let rawAns = aiResponse.answer;
            // if (preferredLanguage !== "english" && !isTextInLanguage(rawAns, preferredLanguage)) {
            //   debugLogger.info("sendMessage: [LLM TRACKING] [5] Translating final answer (IndicTrans2)");
            //   const transStartTime = Date.now();
            //   rawAns = await aiClient.translate(rawAns, "english", preferredLanguage);
            //   const transDuration = Date.now() - transStartTime;
            //   debugLogger.info(`sendMessage: [PERFORMANCE] IndicTrans2 Translation took ${transDuration}ms`);
            // }
            assistantText = rawAns;
            isEmergency = !!aiResponse.emergency;
          } catch {
            assistantText =
              NO_CONTEXT_REPLY_I18N[preferredLanguage] || NO_CONTEXT_REPLY_I18N.english;
          }
        }
      }

      const aiMessage = await chatSessionRepository.appendMessage({
        citations: [],
        content: assistantText,
        metadata: {
          mode,
          emergency: isEmergency,
          documentId: finalDocumentIds || [], // Store exactly which docs were used in message
          task: intent,
        },
        role: "assistant",
        sessionId,
        userId,
      });

      const _reqEndTime = Date.now();
      debugLogger.info("sendMessage: Total request execution time", {
        durationSec: ((_reqEndTime - _reqStartTime) / 1000).toFixed(2),
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
      if (reqSessionId) {
        processingSessions.delete(reqSessionId);
      }
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
  ChatService,
  chatService,
};
