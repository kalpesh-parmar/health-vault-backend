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

const axios = require("axios");

const { env } = require("../../configs/env");
const { errorConstants } = require("../../constants/errorConstants");
const { messageConstants } = require("../../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../../exceptions/appError");
const chatSessionRepository = require("../../repositories/chatSessionRepository");
const intelligenceRepository = require("../../repositories/documentIntelligenceRepository");
const aiServiceClient = require("./aiServiceClient");

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

async function callRagEndpoint({ userId, message, chunks, history, sessionId, documentId }) {
  debugLogger.info("callRagEndpoint: Request payload", {
    userId,
    message: message?.substring(0, 100),
    sessionId,
    documentId,
    chunkCount: chunks?.length || 0,
    historyLength: history?.length || 0,
  });

  // We use the existing /v1/chat handler in the AI service. Here we pre-supply
  // chunks because we have already done retrieval ourselves and need strict scoping.
  const payload = {
    userId, // CRITICAL FIX: Pass userId to Python service
    message,
    sessionId,
    documentId,
    // The AI-service signature: it accepts message + an internal RAG
    // step; we override by including the chunks directly in the message
    // when its native retrieval is not desired. The Python handler is
    // tolerant of an extra 'context' field which it forwards verbatim.
    retrievedChunks: chunks,
    history,
  };

  debugLogger.info("callRagEndpoint: Sending to Python AI service", {
    url: `${env.aiServiceUrl}/v1/chat`,
  });

  let response;
  try {
    response = await axios.post(`${env.aiServiceUrl}/v1/chat`, payload, {
      timeout: 60 * 1000,
    });
  } catch (axiosError) {
    debugLogger.error("callRagEndpoint: HTTP error", {
      status: axiosError.response?.status,
      statusText: axiosError.response?.statusText,
      data: axiosError.response?.data,
      message: axiosError.message,
    });
    throw axiosError;
  }

  debugLogger.info("callRagEndpoint: Raw response received", {
    success: response.data?.success,
    hasData: !!response.data?.data,
    answerLength: response.data?.data?.answer?.length || 0,
    answerPreview: response.data?.data?.answer?.substring(0, 100),
  });

  const data = response.data?.data;

  // Validate response data
  if (!data) {
    debugLogger.error("callRagEndpoint: No data in response", { response: response.data });
    throw new Error("AI service returned empty response");
  }

  if (!data.answer || typeof data.answer !== "string") {
    debugLogger.error("callRagEndpoint: Invalid answer in response", { answer: data.answer });
    throw new Error("AI service returned invalid answer");
  }

  debugLogger.info("callRagEndpoint: Final answer", {
    answerLength: data.answer.length,
    answerPreview: data.answer.substring(0, 100),
    citationsCount: data.citations?.length || 0,
  });

  return data;
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

  async sendMessage({ userId, sessionId, message, documentId }) {
    debugLogger.info("sendMessage: Incoming payload", {
      userId,
      sessionId,
      message: message?.substring(0, 100),
      documentId,
    });

    if (!message?.trim()) {
      throw new InvalidRequestException("Message is required");
    }

    debugLogger.info("sendMessage: Validating session", { sessionId, userId });
    const session = await chatSessionRepository.findSessionById(sessionId, userId);
    if (!session) {
      throw new NotFoundException("Chat session not found");
    }
    debugLogger.info("sendMessage: Session found", {
      sessionId: session.id,
      documentId: session.documentId,
    });

    debugLogger.info("sendMessage: Saving user message");
    const userMessage = await chatSessionRepository.appendMessage({
      content: message.trim(),
      role: "user",
      sessionId,
      userId,
    });

    // 1) Embed the question, search the user's vector store.
    debugLogger.info("sendMessage: Generating embedding for message");
    const queryEmbedding = await aiServiceClient.embedText(message);
    debugLogger.info("sendMessage: Embedding generated", {
      embeddingLength: queryEmbedding?.length || 0,
    });
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      debugLogger.error("sendMessage: Embedding generation failed", { queryEmbedding });
      throw new InvalidRequestException(errorConstants.INVALID_REQUEST);
    }

    debugLogger.info("sendMessage: Searching similar chunks", {
      documentId: documentId || session.documentId || null,
      limit: env.ragTopK,
    });

    const chunks = await intelligenceRepository.searchSimilarChunks({
      documentId: documentId || session.documentId || null,
      limit: env.ragTopK,
      queryEmbedding,
      userId,
    });

    debugLogger.info("sendMessage: Vector search results", {
      totalChunks: chunks.length,
      sampleChunk: chunks[0]
        ? { id: chunks[0].id, content: chunks[0].content?.substring(0, 50) }
        : null,
    });

    const usableChunks = chunks
      .map((chunk) => ({ ...chunk, score: relevance(chunk.distance) }))
      .filter((chunk) => (chunk.score == null ? true : chunk.score >= 1 - MIN_CITATION_RELEVANCE));

    debugLogger.info("sendMessage: Filtered usable chunks", {
      totalChunks: chunks.length,
      usableChunks: usableChunks.length,
    });

    if (!usableChunks.length) {
      debugLogger.info("sendMessage: No relevant chunks found, returning default reply");
      const aiMessage = await chatSessionRepository.appendMessage({
        citations: [],
        content: NO_CONTEXT_REPLY,
        metadata: { reason: "no_relevant_chunks" },
        role: "assistant",
        sessionId,
        userId,
      });
      return { ai: aiMessage, citations: [], reply: NO_CONTEXT_REPLY, user: userMessage };
    }

    const recent = await chatSessionRepository.listMessages({
      direction: "before",
      limit: 8,
      sessionId,
      userId,
    });

    const history = recent.items.map((msg) => ({ content: msg.content, role: msg.role }));

    debugLogger.info("sendMessage: Retrieved chat history", {
      historyLength: history.length,
    });

    let assistantText = NO_CONTEXT_REPLY;
    let citations = [];

    debugLogger.info("sendMessage: Calling RAG endpoint with chunks");

    try {
      const formattedChunks = usableChunks.map(
        ({ chunkId, content, sectionTitle, sourceType, score }) => ({
          chunkId,
          content,
          score,
          sectionTitle,
          sourceType,
        }),
      );

      debugLogger.info("sendMessage: Calling callRagEndpoint", {
        chunkCount: formattedChunks.length,
        messagePreview: message.substring(0, 50),
      });

      const aiResponse = await callRagEndpoint({
        userId,
        message,
        chunks: formattedChunks,
        history,
        sessionId,
        documentId: documentId || session.documentId,
      });

      debugLogger.info("sendMessage: RAG response received", {
        hasAnswer: !!aiResponse?.answer,
        answerLength: aiResponse?.answer?.length || 0,
        citationsCount: aiResponse?.citations?.length || 0,
      });

      if (aiResponse?.answer && typeof aiResponse.answer === "string") {
        assistantText = aiResponse.answer;
        debugLogger.info("sendMessage: Answer extracted", {
          answerPreview: assistantText.substring(0, 100),
        });
      } else {
        debugLogger.error("sendMessage: Invalid AI response", {
          answer: aiResponse?.answer,
          answerType: typeof aiResponse?.answer,
        });
      }
      citations = aiResponse?.citations || usableChunks;
    } catch (error) {
      // Surface a strict, deterministic message instead of an LLM error.
      debugLogger.error("sendMessage: RAG endpoint failed", {
        error: error.message,
        stack: error.stack,
        sessionId,
        userId,
      });
      assistantText = NO_CONTEXT_REPLY;
      citations = [];
    }

    debugLogger.info("sendMessage: Saving assistant message to DB");
    const aiMessage = await chatSessionRepository.appendMessage({
      citations: citations.map((chunk) => ({
        chunkId: chunk.chunkId,
        documentId: chunk.documentId || null,
        score: chunk.score ?? null,
        sectionTitle: chunk.sectionTitle || null,
      })),
      content: assistantText,
      metadata: {
        retrievedChunkIds: usableChunks.map((c) => c.chunkId),
      },
      role: "assistant",
      sessionId,
      userId,
    });

    debugLogger.info("sendMessage: Complete", {
      replyPreview: assistantText.substring(0, 100),
      userMessageId: userMessage?.id,
      aiMessageId: aiMessage?.id,
    });

    return { ai: aiMessage, citations, reply: assistantText, user: userMessage };
  }

  async deleteSession({ sessionId, userId }) {
    const updated = await chatSessionRepository.softDeleteSession(sessionId, userId);
    if (!updated) throw new NotFoundException("Chat session not found");
    return updated;
  }
}

module.exports = new DocumentChatService();
