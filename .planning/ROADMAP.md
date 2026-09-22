# Roadmap: Health Vault Backend

## Overview

This roadmap details milestone **v1.0: Vector Embedding Dimension & Pipeline Alignment**, standardizing vector embedding dimensions across PostgreSQL schemas, environment configurations, Ollama/AI service clients, normalization helpers, and documentation, backed by automated unit tests.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (1.1, 2.1): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Schema, Configuration & Documentation Standardization** - Reconcile 1024-dim standard across models, env configs, and architectural documentation.
- [ ] **Phase 2: Embedding Generation & Client Fallback Integration** - Implement Ollama embedding client method, service fallback, and zero-padding guards.
- [ ] **Phase 3: Automated Verification & Regression Testing** - Comprehensive unit tests for vector normalization and full test suite pass.

## Phase Details

### Phase 1: Schema, Configuration & Documentation Standardization

**Goal**: Establish 1024-dimension vector embeddings as the single source of truth across models, environment configurations, and documentation.
**Depends on**: Nothing (first phase)
**Requirements**: [SCHEMA-01, SCHEMA-02, SCHEMA-03, CONFIG-01, CONFIG-02]
**Success Criteria** (what must be TRUE):

1. `src/models/documentIntelligence.js` defines and documents 1024-dimension vector embedding with no conflicting 384-dim comments.
2. `AGENTS.md` Section 4 declares 1024-dimension vectors matching the database table.
3. `src/configs/env.js` and `.env.example` export and document `embeddingDim` (default 1024) and `embeddingModel`.
4. Codebase reference docs in `.planning/codebase/` reflect the aligned 1024-dimension standard.
   **Plans**: 2 plans

Plans:

- [ ] 01-01: Update Drizzle model comments, `AGENTS.md`, and `.planning/codebase/` documentation to standardize on 1024 dimensions.
- [ ] 01-02: Add `embeddingDim` and `embeddingModel` to `src/configs/env.js` and `.env.example`.

### Phase 2: Embedding Generation & Client Fallback Integration

**Goal**: Provide resilient embedding generation in the client and service layers with automatic dimension normalization.
**Depends on**: Phase 1
**Requirements**: [CLIENT-01, CLIENT-02, CLIENT-03]
**Success Criteria** (what must be TRUE):

1. `src/clients/ollamaClient.js` provides a working `embeddings(prompt, model)` method communicating with `/api/embeddings`.
2. `src/services/ai/chat/embedding.service.js` handles fallback between Ollama and `aiServiceClient.embedText()`.
3. `src/helpers/embedding.helper.js` enforces `env.embeddingDim` (1024) and logs an observability warning when zero-padding occurs.
   **Plans**: 2 plans

Plans:

- [ ] 02-01: Implement `embeddings` method in `ollamaClient.js` with retry handling.
- [ ] 02-02: Update `embedding.service.js` fallback routing and enhance `normalizeVectorDimension()` in `embedding.helper.js`.

### Phase 3: Automated Verification & Regression Testing

**Goal**: Validate vector normalization and client error handling with automated unit tests.
**Depends on**: Phase 2
**Requirements**: [TEST-01, TEST-02, TEST-03]
**Success Criteria** (what must be TRUE):

1. Unit tests in `tests/unit/` verify `normalizeVectorDimension` across truncated, exact, and padded lengths.
2. Unit tests verify `ollamaClient.embeddings` payload generation and error handling.
3. Full Jest unit test suite (`npm run test:unit`) passes with 0 failures.
   **Plans**: 1 plan

Plans:

- [ ] 03-01: Create unit tests for vector normalization and client embedding generation, then verify full test suite.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase                                          | Plans Complete | Status      | Completed |
| ---------------------------------------------- | -------------- | ----------- | --------- |
| 1. Schema, Config & Docs Standardization       | 0/2            | Not started | -         |
| 2. Embedding Generation & Client Fallback      | 0/2            | Not started | -         |
| 3. Automated Verification & Regression Testing | 0/1            | Not started | -         |
