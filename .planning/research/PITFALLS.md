# Pitfalls Research

**Domain:** Clinical Vector Embeddings & Semantic Retrieval
**Researched:** 2026-09-22
**Confidence:** HIGH

## Common Pitfalls

### 1. PostgreSQL Dimension Mismatch Error (Fatal 500)

- **What happens:** PostgreSQL pgvector columns require an exact dimension constraint, e.g. `vector(1024)`. If an application tries to insert an array with 384 or 768 elements without padding, PostgreSQL rejects the transaction with:
  `ERROR: different vector dimensions 384 and 1024`.
- **Why it matters:** Document processing jobs fail catastrophically and get marked as `FAILED`, stopping patient record indexing.
- **Prevention strategy:** Always pass generated vectors through `normalizeVectorDimension(vector, env.embeddingDim || 1024)` before database submission.

### 2. Semantic Degradation from Naive Zero-Padding

- **What happens:** When an embedding of dimension 384 (like `all-MiniLM-L6-v2`) is zero-padded to 1024, more than 60% of the vector consists of trailing zeros. When calculating cosine similarity:
  `cos(θ) = (A · B) / (||A|| ||B||)`
  The dot product only uses the first 384 dimensions, but the norms in the denominator are affected if vectors have differing numbers of zeros, skewing relevance scores.
- **Why it matters:** Can lead to low similarity scores and missed clinical context during RAG retrieval.
- **Prevention strategy:** Recommend matching the native embedding model to the target dimension (1024), e.g., `bge-large-en-v1.5` or `mxbai-embed-large`. Use zero-padding strictly as a protective fallback for development environments, logging a warning when padding occurs.

### 3. Missing Client Method (`TypeError: ... is not a function`)

- **What happens:** `src/services/ai/chat/embedding.service.js:19` invokes `ollamaClient.embeddings(cleanText, env.embeddingModel)`, but `ollamaClient.js` does not have an `embeddings` method.
- **Why it matters:** In production or test environments where Ollama is called, this throws an unhandled TypeError.
- **Prevention strategy:** Implement `embeddings(prompt, model)` on `OllamaClient` using Ollama's native `/api/embeddings` endpoint, and add unit tests verifying the method's interface.

### 4. Divergence Between Code and Architectural Documentation

- **What happens:** Code comments in `documentIntelligence.js` mention 384 dimensions, `AGENTS.md` Section 4 mentions 768 dimensions, and Drizzle schema defines 1024 dimensions.
- **Why it matters:** Engineers or AI agents writing new queries might assume 768 dimensions and introduce schema conflicts or broken test fixtures.
- **Prevention strategy:** Update `AGENTS.md`, schema comments, and codebase documentation in this milestone to uniformly declare 1024 as the standard dimension.

---

_Pitfalls research for: Clinical Vector Embeddings & Semantic Retrieval_
_Researched: 2026-09-22_
