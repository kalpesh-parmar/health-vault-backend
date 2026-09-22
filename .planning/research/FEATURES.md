# Feature Research

**Domain:** Clinical Vector Embeddings & Semantic Retrieval
**Researched:** 2026-09-22
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features assumed to exist for accurate clinical RAG and document question answering.

| Feature                        | Why Expected                                                                                                                  | Complexity | Notes                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| Uniform Dimension Guarantee    | If query vector dimension doesn't match stored chunks, database throws fatal 500 error on chat.                               | LOW        | Ensure schema `dimensions: 1024`, helper normalization, and env config all align.                        |
| Robust Model Client Execution  | Calling `embeddingService.embedText()` must reliably execute and return a valid numeric array, not throw `is not a function`. | MEDIUM     | Implement `ollamaClient.embeddings(prompt, model)` or fallback cleanly to `aiServiceClient.embedText()`. |
| Configurable Environment Knobs | Administrators must be able to configure `EMBEDDING_DIM` and `EMBEDDING_MODEL` via `.env`.                                    | LOW        | Add to `src/configs/env.js` with sensible defaults (1024 / `bge-large-en-v1.5` or `all-MiniLM-L6-v2`).   |
| Consistent Documentation       | Developers reading `AGENTS.md` and codebase docs must see the true schema dimensions to avoid writing incompatible queries.   | LOW        | Correct `AGENTS.md` and `documentIntelligence.js` comments to reflect 1024 dimensions.                   |

### Differentiators (Competitive Advantage)

Features that enhance clinical retrieval accuracy and system robustness.

| Feature                                                      | Value Proposition                                                                                                               | Complexity | Notes                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| Multi-Provider Fallback (Ollama → AI Service → Google GenAI) | If local Ollama is offline or overloaded, embedding generation transparently fails over to cloud or microservice.               | MEDIUM     | Prevents background document processing queue stalls.                             |
| Clinical Text Pre-cleaning & Reasoning Strip                 | Clinical chunks must not contain model internal `<think>` tags or OCR noise before embedding.                                   | LOW        | Already partially implemented via `stripThinking()`, ensure applied consistently. |
| Dimension Zero-Padding Guard with Warning                    | When a smaller dimension model (e.g. 384) is used in development, safely pad with zeros while logging an observability warning. | LOW        | Preserves runtime execution while alerting engineers to semantic degradation.     |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good on the surface but introduce serious bugs or degradation.

| Feature                                                  | Why Requested                                                                           | Why Problematic                                                                                                         | Alternative                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Mixing Different Dimension Models in the Same Table      | Teams try to use 384-dim for some documents and 1024-dim for others without padding.    | PostgreSQL pgvector columns have fixed dimension constraint per column; mixed sizes cause immediate SQL runtime errors. | Standardize on a single column dimension (1024) across the entire table.              |
| Changing Column Dimension on a Live DB without Migration | Quick fix by altering schema code without running `npm run db:generate` & `db:migrate`. | Schema will drift from database state; subsequent inserts or selects will fail in production.                           | Always generate and apply Drizzle Kit migrations when modifying `vector(dimensions)`. |

## Feature Dependencies

```
[Configurable Env Knobs]
    └──enables──> [Uniform Dimension Guarantee]
                      └──requires──> [Robust Model Client Execution]
                                         └──enables──> [Clinical RAG Semantic Retrieval]
```

### Dependency Notes

- **Uniform Dimension Guarantee requires Robust Model Client Execution:** Normalization helpers can only format arrays if the underlying client successfully generates and returns an embedding array.
- **Configurable Env Knobs enables Uniform Dimension Guarantee:** Having `env.embeddingDim` explicitly loaded avoids fallback to undefined or scattered magic numbers.

---

_Feature research for: Clinical Vector Embeddings & Semantic Retrieval_
_Researched: 2026-09-22_
