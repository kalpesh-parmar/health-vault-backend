# Requirements: Health Vault Backend

**Defined:** 2026-09-22
**Core Value:** Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## v1 Requirements

Requirements for milestone v1.0: Vector Embedding Dimension & Pipeline Alignment.

### Schema & Documentation Alignment

- [ ] **SCHEMA-01**: Document intelligence schema in `src/models/documentIntelligence.js` defines `vector("embedding", { dimensions: 1024 })` and code comments are aligned to 1024 dimensions.
- [ ] **SCHEMA-02**: Project specification in `AGENTS.md` Section 4 is updated to declare 1024-dimension vector embeddings matching the database table.
- [ ] **SCHEMA-03**: Codebase reference documents (`.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`) are updated to mark vector dimension mismatch resolved.

### Environment & Configuration

- [ ] **CONFIG-01**: `src/configs/env.js` parses and exports `embeddingDim` (default 1024) and `embeddingModel` (default `bge-large-en-v1.5`).
- [ ] **CONFIG-02**: `.env.example` documents `EMBEDDING_DIM` and `EMBEDDING_MODEL` with usage guidelines.

### Embedding Generation & Client Layer

- [ ] **CLIENT-01**: `src/clients/ollamaClient.js` implements the `embeddings(prompt, model)` method communicating with `/api/embeddings`.
- [ ] **CLIENT-02**: `src/services/ai/chat/embedding.service.js` integrates clean fallback between Ollama and `aiServiceClient.embedText()`.
- [ ] **CLIENT-03**: `src/helpers/embedding.helper.js` normalizes vector dimensions to `env.embeddingDim` and logs a structured warning when padding occurs.

### Testing & Verification

- [ ] **TEST-01**: Unit tests verify `normalizeVectorDimension` correctly handles exact length (1024), shorter length (padding), and longer length (slicing).
- [ ] **TEST-02**: Unit tests verify `ollamaClient.embeddings` formatting and error handling.
- [ ] **TEST-03**: Full unit test suite passes (`npm run test:unit`) with zero regression failures.

## v2 Requirements

Deferred to future releases:

### Extended AI & Retrieval

- **RAG-01**: Add hybrid sparse-dense search combining PostgreSQL full-text search (tsvector) with pgvector cosine similarity.
- **RAG-02**: Implement automated re-indexing CLI to re-embed historical document chunks when switching embedding models.

## Out of Scope

| Feature                                               | Reason                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| External vector database migration (Pinecone/Qdrant)  | PostgreSQL pgvector is already integrated and preserves transactional integrity. |
| Modifying conversational onboarding state transitions | Onboarding state machine is strictly decoupled from vector embeddings.           |
| Altering medication reminder recurrence rules         | Unrelated to vector dimension alignment.                                         |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| SCHEMA-01   | Phase 1 | Pending |
| SCHEMA-02   | Phase 1 | Pending |
| SCHEMA-03   | Phase 1 | Pending |
| CONFIG-01   | Phase 1 | Pending |
| CONFIG-02   | Phase 1 | Pending |
| CLIENT-01   | Phase 2 | Pending |
| CLIENT-02   | Phase 2 | Pending |
| CLIENT-03   | Phase 2 | Pending |
| TEST-01     | Phase 3 | Pending |
| TEST-02     | Phase 3 | Pending |
| TEST-03     | Phase 3 | Pending |

**Coverage:**

- v1 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0 ✓

---

_Requirements defined: 2026-09-22_
_Last updated: 2026-09-22 after initial definition_
