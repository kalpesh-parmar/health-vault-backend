const { env } = require("../../../configs/env");
const { messageConstants } = require("../../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../../exceptions/appError");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { chatSession } = require("../../../models/chatSession");
const { and, eq, desc, isNull } = require("drizzle-orm");

const { ocrOrchestrator } = require("../ocr/ocr.orchestrator");
const { ocrService } = require("../ocr/ocr.service");
const documentPersistenceService = require("../../documentPersistence.service");
const { ollamaClient } = require("../../../clients/ollamaClient");
const { embeddingService } = require("./embedding.service");
const prompts = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const userOnboardingRepository = require("../../../repositories/userOnboardingRepository");
const aiClient = require("../clients/aiClient.service");
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

    // Intercept age-related questions
    const cleanQuestion = question.toLowerCase().replace(/[?.]/g, "").trim();
    if (
      cleanQuestion === "what is my age" ||
      cleanQuestion === "how old am i" ||
      cleanQuestion === "calculate my age"
    ) {
      debugLogger.info("sendMessage: Intercepted age-related question", { question });

      const ageTemplates = AGE_REPLY_I18N[preferredLanguage] || AGE_REPLY_I18N.english;
      let replyText;
      if (p && p.dateOfBirth) {
        let dobStr = p.dateOfBirth;
        if (p.dateOfBirth instanceof Date) {
          dobStr = p.dateOfBirth.toISOString().split("T")[0];
        } else if (typeof p.dateOfBirth === "string") {
          dobStr = p.dateOfBirth.split("T")[0];
        }
        const calculatedAge = getAgeFromDateOfBirth(p.dateOfBirth);
        replyText = ageTemplates.success(dobStr, calculatedAge);
      } else {
        replyText = ageTemplates.missing;
      }

      let session;
      if (reqSessionId) {
        session = await chatSessionRepository.findSessionById(reqSessionId, userId);
        if (!session) {
          throw new NotFoundException("Chat session not found");
        }
      } else if (!documentId?.trim()) {
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
        const [existingDoc] = await db
          .select()
          .from(document)
          .where(
            and(
              eq(document.s3Key, documentId),
              eq(document.userId, userId),
              eq(document.softDelete, false),
            ),
          )
          .limit(1);
        if (existingDoc) {
          const [existingSession] = await db
            .select()
            .from(chatSession)
            .where(
              and(
                eq(chatSession.documentId, existingDoc.id),
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
              documentId: existingDoc.id,
              title: existingDoc.fileName || "Document Chat",
            }));
        } else {
          session = await chatSessionRepository.createSession({
            userId,
            documentId: null,
            title: "General Health Chat",
          });
        }
      }

      const userMsg = await chatSessionRepository.appendMessage({
        content: question.trim(),
        role: "user",
        sessionId: session.id,
        userId,
      });

      const aiMsg = await chatSessionRepository.appendMessage({
        citations: [],
        content: replyText,
        metadata: {
          mode: !documentId?.trim() ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
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
        reply: replyText,
        user: userMsg,
        mode: !documentId?.trim() ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
        emergency: false,
      };
    }

    let isGeneralHealth = !documentId?.trim();

    let session;
    let doc = null;

    if (reqSessionId) {
      session = await chatSessionRepository.findSessionById(reqSessionId, userId);
      if (!session) {
        throw new NotFoundException("Chat session not found");
      }
      if (session.documentId) {
        doc = { id: session.documentId };
        isGeneralHealth = false;
      } else {
        isGeneralHealth = true;
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
      // Document RAG Flow - Retrieve document
      const [existingDoc] = await db
        .select()
        .from(document)
        .where(
          and(
            eq(document.id, documentId),
            eq(document.userId, userId),
            eq(document.softDelete, false),
          ),
        )
        .limit(1);

      if (existingDoc) {
        doc = existingDoc;
      } else {
        // Run OCR if not indexed
        debugLogger.info(
          "sendMessage: Document not found in DB. Fetching and extracting from S3...",
          { documentId },
        );
        let ocrResponse;
        try {
          ocrResponse = await ocrOrchestrator.runFromStorage({
            fileKey: documentId,
            mimeType: "application/pdf",
            traceId: `chat_ocr_${Date.now()}`,
          });
        } catch (error) {
          debugLogger.error("sendMessage: OCR pipeline failed", { error: error.message });
          throw new InvalidRequestException(`OCR processing failed: ${error.message}`);
        }

        let patientContext = null;
        try {
          patientContext = await intelligenceRepository.getPatientContext(userId);
        } catch {
          patientContext = null;
        }

        const { rawOcrData, structured } = await ocrService.normalizeExtraction({
          patientContext,
          rawOcr: ocrResponse,
        });

        const addResult = await documentPersistenceService.addDocument({
          userId,
          payload: {
            fileKey: documentId,
            rawOcrData: {
              ...rawOcrData,
              mimeType: rawOcrData?.mimeType || "application/pdf",
            },
            extractedStructuredData: structured,
          },
        });
        doc = addResult.document;
      }

      // Find or create session for document
      const [existingSession] = await db
        .select()
        .from(chatSession)
        .where(
          and(
            eq(chatSession.documentId, doc.id),
            eq(chatSession.userId, userId),
            eq(chatSession.softDelete, false),
          ),
        )
        .orderBy(desc(chatSession.updatedAt))
        .limit(1);

      session = existingSession;
      if (!session) {
        session = await chatSessionRepository.createSession({
          userId,
          documentId: doc.id,
          title: doc.fileName || "Document Chat",
        });
      }
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
      patientContextStr = `Patient Profile:
Name: ${p.firstName || ""} ${p.lastName || ""}
Gender: ${p.gender || "Unknown"}
Date of Birth: ${dobStr}
Blood Group: ${p.bloodGroup || "Unknown"}`;
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
            "english",
          );
          let rawAns = aiResponse.answer;
          isEmergency = !!aiResponse.emergency;

          if (aiClient && typeof aiClient.translate === "function") {
            assistantText = await aiClient.translate(rawAns, "english", preferredLanguage);
          } else {
            assistantText = rawAns;
          }
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
      debugLogger.info("sendMessage: Generating embedding for RAG query");
      const queryEmbedding = await embeddingService.embedText(question);

      const chunks = await intelligenceRepository.searchSimilarChunks({
        documentId: doc.id,
        limit: env.ragTopK,
        queryEmbedding,
        userId,
      });

      const safeChunks = Array.isArray(chunks) ? chunks : [];
      const usableChunks = safeChunks
        .map((chunk) => ({ ...chunk, score: relevance(chunk.distance) }))
        .filter((chunk) =>
          chunk.score == null ? true : chunk.score >= 1 - MIN_CITATION_RELEVANCE,
        );

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

      debugLogger.info("sendMessage: Calling RAG chat provider in " + preferredLanguage);
      try {
        const formattedChunks = usableChunks.map((c) => ({
          chunkId: c.chunkId || c.id,
          content: c.content,
          score: c.score,
          sectionTitle: c.sectionTitle,
          sourceType: c.sourceType,
          documentId: doc.id,
        }));

        const aiResponse = await this.qwenHealthChat(
          history,
          "DOCUMENT_RAG",
          formattedChunks,
          patientContextStr,
          preferredLanguage,
        );
        assistantText = aiResponse.answer;
        citations = aiResponse.citations || formattedChunks;
        isEmergency = !!aiResponse.emergency;
      } catch (error) {
        debugLogger.error(
          "sendMessage: RAG local language call failed, falling back to translation",
          {
            error: error.message,
          },
        );
        try {
          const formattedChunks = usableChunks.map((c) => ({
            chunkId: c.chunkId || c.id,
            content: c.content,
            score: c.score,
            sectionTitle: c.sectionTitle,
            sourceType: c.sourceType,
            documentId: doc.id,
          }));
          const aiResponse = await this.qwenHealthChat(
            history,
            "DOCUMENT_RAG",
            formattedChunks,
            patientContextStr,
            "english",
          );
          let rawAns = aiResponse.answer;
          citations = aiResponse.citations || formattedChunks;
          isEmergency = !!aiResponse.emergency;

          if (aiClient && typeof aiClient.translate === "function") {
            assistantText = await aiClient.translate(rawAns, "english", preferredLanguage);
          } else {
            assistantText = rawAns;
          }
        } catch (fallbackErr) {
          debugLogger.error("sendMessage: RAG fallback failed", { error: fallbackErr.message });
          assistantText = fallbackNoContext;
        }
      }
    }

    // Save assistant message to DB
    const aiMessage = await chatSessionRepository.appendMessage({
      citations: (Array.isArray(citations) ? citations : []).map((chunk) => ({
        chunkId: chunk.chunkId || chunk.id || null,
        documentId: doc ? doc.id : null,
        score: chunk.score ?? null,
        sectionTitle: chunk.sectionTitle || null,
      })),
      content: assistantText,
      metadata: {
        mode: isGeneralHealth ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
        emergency: isEmergency,
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
