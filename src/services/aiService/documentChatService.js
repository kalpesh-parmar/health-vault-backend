/**
 * Document-only medical chat.
 *
 * Strict guarantees
 * ─────────────────
 *  • Retrieval is constrained to the authenticated user's documents.
 *  • Prompt forbids the LLM from using any external knowledge.
 *  • If no relevant chunks are returned by pgvector, we respond with the
 *    canonical "Information not found in uploaded reports." message and
 *    do NOT call the LLM at all (saves tokens, blocks hallucinations).
 *
 * Pipeline
 * ────────
 *   1. Validate session ownership.
 *   2. Embed the question via FastAPI `/v1/embeddings`.
 *   3. Vector-search the user's chunks (cosine distance, top-K).
 *   4. If we have hits, call FastAPI `/v1/chat` with a hardened
 *      prompt that includes ONLY the retrieved chunks + recent message
 *      history.
 *   5. Persist user + assistant messages.
 */

const { env } = require("../../configs/env");
const { messageConstants } = require("../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../exceptions/appError");
const chatSessionRepository = require("../../repositories/chatSessionRepository");
const DocumentIntelligenceRepository = require("../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { db } = require("../../configs/db");
const { document } = require("../../models/document");
const { chatSession } = require("../../models/chatSession");
const { and, eq, desc, isNull } = require("drizzle-orm");
const ocrOrchestratorService = require("./ocr/ocrOrchestratorService");
const medicalExtractionService = require("./medicalExtractionService");
const documentPersistenceService = require("../documentPersistenceService");
const { aiProvider } = require("../ai/aiProvider.ts");

// Debug logger - use console for now, should use proper logger in production
const debugLogger = {
  info: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
  error: (msg, data) => console.error(`[DEBUG ERROR] ${msg}`, JSON.stringify(data, null, 2)),
};

const NO_CONTEXT_REPLY = "Information not found in uploaded reports.";
const MIN_CITATION_RELEVANCE = 0.7; // cosine similarity ≥ 0.3 distance ≤ 0.7

function relevance(distance) {
  // pgvector returns cosine distance (0 identical, 2 opposite). Convert to
  // a 0-1 similarity score for the FE; threshold prevents low-quality hits.
  if (distance == null) return null;
  return Math.max(0, Math.min(1, 1 - Number(distance)));
}

class DocumentChatService {
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

  async sendMessage({ userId, documentKey, question }) {
    debugLogger.info("sendMessage: Incoming payload", {
      userId,
      documentKey,
      question: question?.substring(0, 100),
    });

    if (!question?.trim()) {
      throw new InvalidRequestException("Question is required");
    }

    // Branch based on presence of documentKey
    const isGeneralHealth = !documentKey?.trim();

    let session;
    let doc = null;

    if (isGeneralHealth) {
      // 1) Find or create general health session
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
      // 2) Document RAG Flow - Retrieve document
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
          ocrResponse = await ocrOrchestratorService.runFromStorage({
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

        const { rawOcrData, structured } = await medicalExtractionService.extract({
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
        const aiResponse = await aiProvider.chat(history, "GENERAL_HEALTH");
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
      const queryEmbedding = await aiProvider.embeddings(question);

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

        const aiResponse = await aiProvider.chat(history, "DOCUMENT_RAG", formattedChunks);
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
}

module.exports = new DocumentChatService();
