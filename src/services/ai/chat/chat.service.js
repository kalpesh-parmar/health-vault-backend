const { env } = require("../../../configs/env");
const { messageConstants } = require("../../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../../exceptions/appError");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { chatSession } = require("../../../models/chatSession");
const { and, eq, desc, isNull, inArray } = require("drizzle-orm");

// const { ocrOrchestrator } = require("../ocr/ocr.orchestrator");
// const { ocrService } = require("../ocr/ocr.service");
// const documentPersistenceService = require("../../documentPersistenceService");
const { ollamaClient } = require("../clients/ollamaClient");
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
const MIN_CITATION_RELEVANCE = 0.7; // cosine similarity ≥ 0.3 distance ≤ 0.7

const NO_CONTEXT_REPLY_I18N = {
  english: "Information not found in uploaded reports.",
  gujarati: "અપલોડ કરેલા અહેવાલોમાં આ માહિતી મળી નથી.",
  hindi: "अपलोड की गई रिपोर्ट में यह जानकारी नहीं मिली।",
  marathi: "अपलोड केलेल्या अहवालात ही माहिती आढळली नाही.",
  tamil: "பதிவேற்றப்பட்ட அறிக்கைகளில் இந்தத் தகவல் காணப்படவில்லை.",
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

function relevance(distance) {
  if (distance == null) return null;
  return Math.max(0, Math.min(1, 1 - Number(distance)));
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
        .map(
          (c, idx) =>
            `[Chunk Index: ${idx + 1}, ID: ${c.chunkId || c.id}, Section: ${c.sectionTitle || "Report Content"}, Source: ${c.sourceType}, Similarity Score: ${(c.score ?? 1.0).toFixed(2)}]\nContent: ${c.content}`,
        )
        .join("\n\n");

      let systemPrompt = prompts.RAG_PROMPT_TEMPLATE(contextText, normLang);
      if (patientContextStr) {
        systemPrompt += `\n\n${patientContextStr}`;
      }
      const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

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

    if (interceptedReply !== null) {
      let session;
      if (reqSessionId) {
        session = await chatSessionRepository.findSessionById(reqSessionId, userId);
        if (!session) {
          throw new NotFoundException("Chat session not found");
        }
        if (documentId && documentId.length > 0) {
          await chatSessionRepository.attachDocument(reqSessionId, userId, documentId);
          session.documentId = documentId;
        }
      } else if (!documentId || documentId.length === 0) {
        const [existingSession] = await db
          .select()
          .from(chatSession)
          .where(
            and(
              isNull(chatSession.documentId),
              eq(chatSession.userId, userId),
              eq(chatSession.softDelete, false),
            ),
          )
          .orderBy(desc(chatSession.updatedAt))
          .limit(1);
        session =
          existingSession ||
          (await chatSessionRepository.createSession({
            userId,
            documentId: null,
            title: "General Health Chat",
          }));
      } else {
        session = await chatSessionRepository.createSession({
          userId,
          documentId: documentId && documentId.length > 0 ? documentId : null,
          title: "Multi-Document Chat",
          metadata: { documentId: documentId || [] },
        });
      }

      const userMsg = await chatSessionRepository.appendMessage({
        content: question.trim(),
        role: "user",
        sessionId: session.id,
        userId,
      });

      const aiMsg = await chatSessionRepository.appendMessage({
        citations: [],
        content: interceptedReply,
        metadata: {
          mode: !documentId || documentId.length === 0 ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
          emergency: false,
          intercepted: true,
        },
        role: "assistant",
        sessionId: session.id,
        userId,
      });

      return {
        ai: aiMsg,
        citations: [],
        reply: interceptedReply,
        user: userMsg,
        mode: !documentId || documentId.length === 0 ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
        emergency: false,
      };
    }

    let isGeneralHealth = !documentId || documentId.length === 0;

    let session;
    // let doc = null;

    if (reqSessionId) {
      session = await chatSessionRepository.findSessionById(reqSessionId, userId);
      if (!session) {
        throw new NotFoundException("Chat session not found");
      }
      if (
        session.documentId &&
        Array.isArray(session.documentId) &&
        session.documentId.length > 0
      ) {
        isGeneralHealth = false;
      } else if (session.documentId && typeof session.documentId === "string") {
        isGeneralHealth = false;
      }
      // If there are documentId provided in payload, it overrides general health
      if (documentId && documentId.length > 0) {
        isGeneralHealth = false;
        await chatSessionRepository.attachDocument(reqSessionId, userId, documentId);
        session.documentId = documentId;
        if (!session.metadata) session.metadata = {};
        session.metadata.documentId = documentId;
      } else if (
        session.documentId &&
        Array.isArray(session.documentId) &&
        session.documentId.length > 0
      ) {
        documentId = session.documentId;
        isGeneralHealth = false;
      } else if (session.documentId && typeof session.documentId === "string") {
        documentId = [session.documentId];
        isGeneralHealth = false;
      } else if (session.metadata?.documentId && session.metadata.documentId.length > 0) {
        // If the session was created with multiple document IDs, use them
        documentId = session.metadata.documentId;
        isGeneralHealth = false;
      }
    } else if (isGeneralHealth) {
      // Find or create general health session
      const [existingSession] = await db
        .select()
        .from(chatSession)
        .where(
          and(
            isNull(chatSession.documentId),
            eq(chatSession.userId, userId),
            eq(chatSession.softDelete, false),
          ),
        )
        .orderBy(desc(chatSession.updatedAt))
        .limit(1);

      session = existingSession;
      if (!session) {
        debugLogger.info("sendMessage: Creating new general health session");
        session = await chatSessionRepository.createSession({
          userId,
          documentId: null,
          title: "General Health Chat",
        });
      }
    } else {
      // Multi-Document RAG Flow
      session = await chatSessionRepository.createSession({
        userId,
        documentId: documentId && documentId.length > 0 ? documentId : null,
        title: "Multi-Document Chat",
        metadata: { documentId: documentId || [] },
      });
    }

    const sessionId = session.id;

    // Append user message
    const userMessage = await chatSessionRepository.appendMessage({
      content: question.trim(),
      role: "user",
      sessionId,
      userId,
    });

    let assistantText = NO_CONTEXT_REPLY;
    let citations = [];
    let isEmergency = false;

    let patientContextStr = "";
    if (p) {
      let dobStr = "Unknown";
      if (p.dateOfBirth) {
        dobStr =
          p.dateOfBirth instanceof Date
            ? p.dateOfBirth.toISOString().split("T")[0]
            : String(p.dateOfBirth).split("T")[0];
      }
      const allergiesStr =
        p.allergies && Array.isArray(p.allergies) && p.allergies.length > 0
          ? p.allergies.join(", ")
          : "None";

      if (isGeneralHealth) {
        patientContextStr = `Patient Profile Context:
Name: ${p.firstName || ""} ${p.lastName || ""}
Gender: ${p.gender || "Unknown"}
Date of Birth: ${dobStr}
Blood Group: ${p.bloodGroup || "Unknown"}
Allergies: ${allergiesStr}

IMPORTANT INSTRUCTION: Use the above profile information ONLY to answer the user's specific question. Do not volunteer extra information if the user didn't explicitly ask for it.`;
      } else {
        patientContextStr = `Patient Profile Context:
Name: ${p.firstName || ""} ${p.lastName || ""}
Gender: ${p.gender || "Unknown"}
Date of Birth: ${dobStr}
Blood Group: ${p.bloodGroup || "Unknown"}
Allergies: ${allergiesStr}

IMPORTANT INSTRUCTION: Use the above profile information ONLY to answer the user's specific question. Do not volunteer extra information if the user didn't explicitly ask for it.`;
      }
    }

    if (isGeneralHealth) {
      // General Health chat flow
      const recent = await chatSessionRepository.listMessages({
        direction: "before",
        limit: 8,
        sessionId,
        userId,
      });
      const items = recent && Array.isArray(recent.items) ? recent.items : [];
      const history = items.map((msg) => ({ content: msg.content, role: msg.role }));

      debugLogger.info("sendMessage: Calling general health chat provider in " + preferredLanguage);
      try {
        const aiResponse = await this.qwenHealthChat(
          history,
          "GENERAL_HEALTH",
          [],
          patientContextStr,
          preferredLanguage,
        );
        assistantText = aiResponse.answer;
        isEmergency = !!aiResponse.emergency;
      } catch (error) {
        debugLogger.error(
          "sendMessage: Local direct language call failed, falling back to translation",
          {
            error: error.message,
          },
        );
        try {
          const aiResponse = await this.qwenHealthChat(
            history,
            "GENERAL_HEALTH",
            [],
            patientContextStr,
            preferredLanguage,
          );
          let rawAns = aiResponse.answer;
          isEmergency = !!aiResponse.emergency;

          assistantText = rawAns;
        } catch (fallbackErr) {
          debugLogger.error("sendMessage: General health fallback failed", {
            error: fallbackErr.message,
          });
          assistantText =
            preferredLanguage === "gujarati"
              ? "માફ કરશો, હું અત્યારે તમારી વિનંતી પર પ્રક્રિયા કરવામાં અસમર્થ છું. કૃપા કરીને પછીથી ફરી પ્રયાસ કરો."
              : preferredLanguage === "hindi"
                ? "क्षमा करें, मैं वर्तमान में आपके अनुरोध को संसाधित करने में असमर्थ हूँ। कृपया बाद में पुनः प्रयास करें।"
                : preferredLanguage === "marathi"
                  ? "क्षमस्व, मी सध्या आपल्या विनंतीवर प्रक्रिया करण्यास असमर्थ आहे. कृपया नंतर पुन्हा प्रयत्न करा."
                  : preferredLanguage === "tamil"
                    ? "மன்னிக்கவும், தற்போது உங்களது கோரிக்கையை எங்களால் செயல்படுத்த முடியவில்லை. தயவுசெய்து பின்னர் மீண்டும் முயற்சிக்கவும்."
                    : "Sorry, I am currently unable to process your request. Please try again later.";
        }
      }
    } else {
      // Document RAG flow

      // Fetch metadata and pre-computed summaries for all requested documents
      let docsMetadata = [];
      try {
        docsMetadata = await db
          .select({
            id: document.id,
            fileName: document.fileName,
            documentType: document.documentType,
            createdAt: document.createdAt,
            reportDate: document.reportDate,
            summaryEnglish: document.summaryEnglish,
          })
          .from(document)
          .where(inArray(document.id, documentId));
      } catch (err) {
        debugLogger.error("sendMessage: Failed to fetch document metadata", { error: err.message });
      }

      let searchDocumentIds = documentId;
      // Skip intent classifier overhead for 3 or fewer explicitly selected documents
      if (documentId && documentId.length > 3) {
        if (docsMetadata.length > 0) {
          const docsListStr = docsMetadata
            .map(
              (d) =>
                `- ID: ${d.id}, Name: ${d.fileName || "Unknown"}, Type: ${d.documentType || "Unknown"}, Date: ${d.createdAt.toISOString().split("T")[0]}`,
            )
            .join("\n");
          const intentPrompt = `The user uploaded the following medical documents:
${docsListStr}

User Question: "${question}"

Your task is to identify which of the above document ID(s) are strictly necessary to answer the user's question.
If the question requires comparing or aggregating information from multiple documents, list all relevant IDs.
Return ONLY a valid JSON array of strings containing the selected document IDs. Do not write any other text.
Example output: ["id1", "id2"]`;

          debugLogger.info("sendMessage: Running intent classifier for multiple documents");
          const intentResponse = await ollamaClient.generate(intentPrompt, env.chatModel, {
            temperature: 0,
            maxTokens: 150,
          });

          try {
            // Safely extract JSON array from response if there is markdown wrapper
            const jsonMatch = intentResponse.match(/\[.*\]/s);
            const jsonString = jsonMatch ? jsonMatch[0] : intentResponse;

            const parsedIds = JSON.parse(jsonString);
            if (Array.isArray(parsedIds) && parsedIds.length > 0) {
              // Ensure the returned IDs are actually part of the original set
              const validIds = parsedIds.filter((id) => documentId.includes(id));
              if (validIds.length > 0) {
                searchDocumentIds = validIds;
                debugLogger.info("sendMessage: Intent classifier filtered documents", {
                  originalCount: documentId.length,
                  newCount: searchDocumentIds.length,
                  searchDocumentIds,
                });
              }
            }
          } catch (parseErr) {
            debugLogger.error("sendMessage: Failed to parse intent classifier response", {
              error: parseErr.message,
              response: intentResponse,
            });
          }
        }
      }
      debugLogger.info("sendMessage: Generating embedding for RAG query");
      const queryEmbedding = await embeddingService.embedText(question);

      const chunks = await intelligenceRepository.searchSimilarChunks({
        documentIds: searchDocumentIds,
        limit: Math.min(15, env.ragTopK + searchDocumentIds.length),
        queryEmbedding,
        userId,
      });

      const safeChunks = Array.isArray(chunks) ? chunks : [];
      let usableChunks = safeChunks
        .map((chunk) => ({ ...chunk, score: relevance(chunk.distance) }))
        .filter((chunk) =>
          chunk.score == null ? true : chunk.score >= 1 - MIN_CITATION_RELEVANCE,
        );

      // Fallback: If semantic similarity is low (e.g. short/misspelled queries), pad with the top matches
      if (usableChunks.length < env.ragTopK && safeChunks.length > 0) {
        const existingIds = new Set(usableChunks.map((c) => c.chunkId || c.id));
        for (const c of safeChunks) {
          if (usableChunks.length >= env.ragTopK) break;
          if (!existingIds.has(c.chunkId || c.id)) {
            usableChunks.push({ ...c, score: relevance(c.distance) });
          }
        }
      }

      // Inject Pre-Computed Summaries to prevent token bloat and timeouts
      const summaryChunks = docsMetadata
        .filter((d) => searchDocumentIds.includes(d.id) && d.summaryEnglish)
        .map((d) => {
          const dateStr = d.reportDate
            ? ` (Dated: ${d.reportDate.toISOString().split("T")[0]})`
            : "";
          return {
            chunkId: `summary-${d.id}`,
            documentId: d.id,
            sectionTitle: `Full Document Summary: ${d.fileName || "Unknown"}${dateStr}`,
            content: d.summaryEnglish,
            score: 1.0,
            sourceType: "ai_summary",
          };
        });

      usableChunks = [...summaryChunks, ...usableChunks];

      const fallbackNoContext =
        NO_CONTEXT_REPLY_I18N[preferredLanguage] || NO_CONTEXT_REPLY_I18N.english;

      if (!usableChunks.length) {
        const aiMessage = await chatSessionRepository.appendMessage({
          citations: [],
          content: fallbackNoContext,
          metadata: { reason: "no_relevant_chunks" },
          role: "assistant",
          sessionId,
          userId,
        });
        return {
          ai: aiMessage,
          citations: [],
          reply: fallbackNoContext,
          user: userMessage,
          mode: "DOCUMENT_RAG",
          emergency: false,
        };
      }

      const recent = await chatSessionRepository.listMessages({
        direction: "before",
        limit: 8,
        sessionId,
        userId,
      });
      const items = recent && Array.isArray(recent.items) ? recent.items : [];
      const history = items.map((msg) => ({ content: msg.content, role: msg.role }));

      debugLogger.info(
        "sendMessage: Calling RAG chat provider in english (Translate-Out approach)",
      );
      try {
        const formattedChunks = usableChunks.map((c) => ({
          chunkId: c.chunkId || c.id,
          content: c.content,
          score: c.score,
          sectionTitle: c.sectionTitle,
          sourceType: c.sourceType,
          documentId: c.documentId,
        }));

        const aiResponse = await this.qwenHealthChat(
          history,
          "DOCUMENT_RAG",
          formattedChunks,
          patientContextStr,
          preferredLanguage,
        );
        let rawAns = aiResponse.answer;
        citations = aiResponse.citations || formattedChunks;
        isEmergency = !!aiResponse.emergency;

        assistantText = rawAns;
      } catch (error) {
        debugLogger.error("sendMessage: RAG English call failed", { error: error.message });
        assistantText = fallbackNoContext;
      }
    } // Close Document RAG else block here

    // Save assistant message to DB
    const aiMessage = await chatSessionRepository.appendMessage({
      citations: (Array.isArray(citations) ? citations : []).map((chunk) => ({
        chunkId: chunk.chunkId || chunk.id || null,
        documentId: chunk.documentId || null,
        score: chunk.score ?? null,
        sectionTitle: chunk.sectionTitle || null,
      })),
      content: assistantText,
      metadata: {
        mode: isGeneralHealth ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
        emergency: isEmergency,
        documentId: documentId || [],
      },
      role: "assistant",
      sessionId,
      userId,
    });

    return {
      ai: aiMessage,
      citations,
      reply: assistantText,
      user: userMessage,
      mode: isGeneralHealth ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
      emergency: isEmergency,
    };
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
