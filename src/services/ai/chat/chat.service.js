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
const documentPersistenceService = require("../../documentPersistenceService");
const { ollamaClient } = require("../clients/ollamaClient");
const { embeddingService } = require("./embedding.service");
const prompts = require("../prompts");
const patientRepository = require("../../../repositories/patientRepository");
const { getAgeFromDateOfBirth } = require("../../../helpers/dateHelper");

// Debug logger
const debugLogger = {
  info: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
  error: (msg, data) => console.error(`[DEBUG ERROR] ${msg}`, JSON.stringify(data, null, 2)),
};

const NO_CONTEXT_REPLY = "Information not found in uploaded reports.";
const MIN_CITATION_RELEVANCE = 0.7; // cosine similarity ≥ 0.3 distance ≤ 0.7

function relevance(distance) {
  if (distance == null) return null;
  return Math.max(0, Math.min(1, 1 - Number(distance)));
}

class ChatService {
  detectEmergency(text) {
    const cleanText = String(text || "").toLowerCase();
    return prompts.EMERGENCY_KEYWORDS.some((keyword) => cleanText.includes(keyword));
  }

  async qwenHealthChat(messages, mode, contextChunks = [], patientContextStr = "") {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const userQuery = lastUserMessage?.content || "";

    if (this.detectEmergency(userQuery)) {
      return {
        answer: prompts.EMERGENCY_WARNING,
        mode,
        emergency: true,
        citations: [],
      };
    }

    if (mode === "DOCUMENT_RAG") {
      if (!contextChunks || contextChunks.length === 0) {
        return {
          answer: NO_CONTEXT_REPLY,
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

      let systemPrompt = prompts.RAG_PROMPT_TEMPLATE(contextText);
      if (patientContextStr) {
        systemPrompt += `\n\n${patientContextStr}`;
      }
      const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

      console.log(`[ChatService] Running local RAG chat using ${env.chatModel}...`);
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

    let systemPrompt = prompts.GENERAL_HEALTH_PROMPT;
    if (patientContextStr) {
      systemPrompt += `\n\n${patientContextStr}`;
    }

    const formattedMessages = [{ role: "system", content: systemPrompt }, ...messages];

    console.log(`[ChatService] Running local general chat using ${env.chatModel}...`);
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

  async sendMessage({ userId, documentKey, question, sessionId: reqSessionId }) {
    debugLogger.info("sendMessage: Incoming payload", {
      userId,
      documentKey,
      reqSessionId,
      question: question?.substring(0, 100),
    });

    if (!question?.trim()) {
      throw new InvalidRequestException("Question is required");
    }

    // Intercept age-related questions
    const cleanQuestion = question.toLowerCase().replace(/[?.]/g, "").trim();
    if (
      cleanQuestion === "what is my age" ||
      cleanQuestion === "how old am i" ||
      cleanQuestion === "calculate my age"
    ) {
      debugLogger.info("sendMessage: Intercepted age-related question", { question });

      const p = await patientRepository.findById(userId);
      let replyText;
      if (p && p.dateOfBirth) {
        let dobStr = p.dateOfBirth;
        if (p.dateOfBirth instanceof Date) {
          dobStr = p.dateOfBirth.toISOString().split("T")[0];
        } else if (typeof p.dateOfBirth === "string") {
          dobStr = p.dateOfBirth.split("T")[0];
        }
        const calculatedAge = getAgeFromDateOfBirth(p.dateOfBirth);
        replyText = `Based on your date of birth (${dobStr}), you are ${calculatedAge} years old.`;
      } else {
        replyText =
          "Your date of birth is not specified in your profile, so I cannot calculate your age.";
      }

      let session;
      if (reqSessionId) {
        session = await chatSessionRepository.findSessionById(reqSessionId, userId);
        if (!session) {
          throw new NotFoundException("Chat session not found");
        }
      } else if (!documentKey?.trim()) {
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
              eq(document.s3Key, documentKey),
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
          mode: !documentKey?.trim() ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
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
        mode: !documentKey?.trim() ? "GENERAL_HEALTH" : "DOCUMENT_RAG",
        emergency: false,
      };
    }

    let isGeneralHealth = !documentKey?.trim();

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
            eq(document.s3Key, documentKey),
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
          { documentKey },
        );
        let ocrResponse;
        try {
          ocrResponse = await ocrOrchestrator.runFromStorage({
            fileKey: documentKey,
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
            fileKey: documentKey,
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
    try {
      const p = await patientRepository.findById(userId);
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
    } catch (err) {
      debugLogger.error("sendMessage: Failed to fetch patient profile", { error: err.message });
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

      debugLogger.info("sendMessage: Calling general health chat provider");
      try {
        const aiResponse = await this.qwenHealthChat(
          history,
          "GENERAL_HEALTH",
          [],
          patientContextStr,
        );
        assistantText = aiResponse.answer;
        isEmergency = !!aiResponse.emergency;
      } catch (error) {
        debugLogger.error("sendMessage: General health provider call failed", {
          error: error.message,
        });
        assistantText =
          "Sorry, I am currently unable to process your request. Please try again later.";
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

      if (!usableChunks.length) {
        const aiMessage = await chatSessionRepository.appendMessage({
          citations: [],
          content: NO_CONTEXT_REPLY,
          metadata: { reason: "no_relevant_chunks" },
          role: "assistant",
          sessionId,
          userId,
        });
        return {
          ai: aiMessage,
          citations: [],
          reply: NO_CONTEXT_REPLY,
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

      debugLogger.info("sendMessage: Calling RAG chat provider");
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
        );
        assistantText = aiResponse.answer;
        citations = aiResponse.citations || formattedChunks;
        isEmergency = !!aiResponse.emergency;
      } catch (error) {
        debugLogger.error("sendMessage: RAG chat provider call failed", { error: error.message });
        assistantText = NO_CONTEXT_REPLY;
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
