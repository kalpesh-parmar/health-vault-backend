# Health Vault Backend

## What This Is

Health Vault is a secure, AI-powered healthcare portal backend designed to manage patient medical records, extract structured clinical data from uploaded documents, orchestrate medication adherence schedules, and facilitate contextual RAG (Retrieval-Augmented Generation) health chats. Built on Express.js and PostgreSQL with pgvector, it supports multi-device sessions, FCM push notifications, and a bilingual onboarding process in English and Gujarati.

## Core Value

Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## Current Milestone: v1.0 Vector Embedding Dimension & Pipeline Alignment

**Goal:** Unify and align vector embedding dimensions, model configuration, schemas, and pipeline services across the codebase and documentation.

**Target features:**

- Reconcile vector dimension standard (1024 vs 768 vs 384) across Drizzle schema (`src/models/documentIntelligence.js`), helpers (`embedding.helper.js`), services (`embedding.service.js`), and docs (`AGENTS.md`)
- Add explicit environment configurations (`EMBEDDING_DIM`, `EMBEDDING_MODEL`) to `src/configs/env.js` and `.env.example`
- Fix embedding generation client integration (`ollamaClient.embeddings` or properly routed `aiServiceClient` / Gemini embedding client)
- Update unit tests to validate consistent dimensionality and prevent regression

## Requirements

### Validated

- ✓ Mobile OTP authentication and JWT session management — v1.0
- ✓ Multi-stage asynchronous document processing pipeline with SSE real-time updates — v1.0
- ✓ Resilient background job queue with heartbeat monitoring and boot recovery — v1.0
- ✓ Deterministic bilingual patient onboarding state machine — v1.0
- ✓ Medication adherence scheduling and cron-based dosage alerts — v1.0

### Active

- [ ] **EMBED-01**: Document and enforce standard vector embedding dimension (1024-dim) across Drizzle schema, AGENTS.md, and codebase docs
- [ ] **EMBED-02**: Add explicit environment configurations (`EMBEDDING_DIM`, `EMBEDDING_MODEL`) with validated fallbacks in `src/configs/env.js` and `.env.example`
- [ ] **EMBED-03**: Implement reliable embedding generation in client layer (support Ollama embedding API or route to `aiServiceClient`/Gemini) with dimensionality normalization
- [ ] **EMBED-04**: Add unit tests in `tests/unit/` verifying vector dimension normalization and error handling for text embedding

### Out of Scope

- Migrating away from PostgreSQL `pgvector` to external vector DBs (Pinecone, Qdrant) — pgvector is already integrated and sufficient
- Modifying onboarding deterministic conversational state machine — already validated
- Changing core medication reminder scheduling logic

## Context

- The codebase previously defined `vector("embedding", { dimensions: 1024 })` in `src/models/documentIntelligence.js`, while comments noted 384 dims (from sentence-transformers in `ai-service`) and AGENTS.md stated 768 dims.
- `src/services/ai/chat/embedding.service.js` attempted to call `ollamaClient.embeddings()`, but `ollamaClient.js` lacked an `embeddings()` method.
- `normalizeVectorDimension` in `src/helpers/embedding.helper.js` handles padding/truncating to target dimensions, but `env.embeddingDim` was missing from `src/configs/env.js`.

## Constraints

- **Tech Stack**: CommonJS JavaScript only (`require`/`module.exports`), Node.js runtime. No TypeScript.
- **Architecture**: Decoupled clean architecture (Route → Validation → Controller → Service → Repository → Model).
- **Messaging**: All messages must come from `src/constants/`. No hardcoded strings.
- **Database**: PostgreSQL with `pgvector` extension; any schema changes must be generated via Drizzle Kit.

## Key Decisions

| Decision                                                           | Rationale                                                                                                                                                                                          | Outcome   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Standardize on 1024-dim vector embeddings                          | Matches existing database column definition in `src/models/documentIntelligence.js` and accommodates high-performance models (e.g. Gemini / Qwen / BGE-large) while normalizing smaller embeddings | — Pending |
| Expose `EMBEDDING_DIM` & `EMBEDDING_MODEL` in `src/configs/env.js` | Eliminates hidden defaults and aligns Node API with Python `ai-service` settings                                                                                                                   | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

_Last updated: 2026-09-22 after milestone v1.0 initialization_
