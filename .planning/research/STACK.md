# Stack Research

**Domain:** PostgreSQL pgvector & Clinical Embedding Infrastructure
**Researched:** 2026-09-22
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology                                    | Version                       | Purpose                               | Why Recommended                                                                                                                                                         |
| --------------------------------------------- | ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL + `pgvector`                       | PostgreSQL 16 / pgvector 0.7+ | Vector similarity search storage      | Native in-database vector index (HNSW / IVFFlat), eliminating separate vector database operational overhead while keeping transactional integrity with patient records. |
| Drizzle ORM (`drizzle-orm/pg-core`)           | `^0.45.2`                     | Schema definition & SQL builder       | Native `vector("embedding", { dimensions: N })` column type and SQL operator helpers (`cosineDistance`, `sql` template tags) with automated Drizzle Kit migrations.     |
| Ollama Embeddings API                         | `v0.5+`                       | Local/On-premise embedding generation | Provides fast offline inference for models like `bge-large-en-v1.5` (1024 dims), `qwen2.5` embeddings, or `nomic-embed-text` without external data exfiltration.        |
| Google GenAI Embedding (`text-embedding-004`) | SDK `^2.7.0`                  | Cloud embedding generation fallback   | State-of-the-art multilingual and medical retrieval performance, native support for configurable output dimensions (768 or truncated).                                  |
| Python FastAPI AI Service                     | `0.115.6`                     | Auxiliary embedding microservice      | Houses PyTorch/Sentence-Transformers (`all-MiniLM-L6-v2` or `bge-m3`) with GPU/CPU acceleration.                                                                        |

### Supporting Libraries

| Library                    | Version          | Purpose                          | When to Use                                                          |
| -------------------------- | ---------------- | -------------------------------- | -------------------------------------------------------------------- |
| `pg`                       | `^8.20.0`        | Node.js PostgreSQL pool driver   | Connection pooling and raw SQL execution for vector operators.       |
| `dotenv` / custom `env.js` | `^17.4.2`        | Typed runtime environment loader | Exposes `EMBEDDING_DIM` (default 1024) and `EMBEDDING_MODEL` safely. |
| `sentence-transformers`    | `3.3.1` (Python) | Local dense embedding inference  | Used inside `ai-service` for batch embedding tasks.                  |

### Development Tools

| Tool                        | Purpose                                        | Notes                                                                      |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Drizzle Kit (`drizzle-kit`) | Generates schema migration DDL                 | When altering vector column dimensions from 1024 or applying HNSW indexes. |
| Jest (`jest`)               | Unit testing embedding dimension normalization | Ensures vectors always match schema dimension before reaching DB.          |

## Installation

```bash
# Core Node dependencies already present:
# npm install drizzle-orm pg

# Python service requirements (ai-service/requirements.txt):
# pip install sentence-transformers asyncpg
```

## Alternatives Considered

| Recommended                     | Alternative                   | When to Use Alternative                                                                                                                                                                                             |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL `pgvector` (Current) | Pinecone / Qdrant / Milvus    | Only if vector collection exceeds tens of millions of documents and requires independent distributed horizontal scaling. For Health Vault, keeping vectors in PostgreSQL preserves ACID patient privacy boundaries. |
| 1024-Dimension Vectors          | 768-Dimension (Standard BERT) | When standardizing on Google GenAI `text-embedding-004` (768 dims) across all cloud-only flows. 1024 dims fits modern top-tier models (BGE-Large, Qwen-embedding, snowflake-arctic-embed-m).                        |
| 1024-Dimension Vectors          | 384-Dimension (MiniLM)        | Lightweight CPU deployments, but sacrifices clinical semantic nuance and complex medical relationship capture.                                                                                                      |

## What NOT to Use

| Avoid                                                                           | Why                                                                                                                       | Use Instead                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --- | --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Arbitrary zero-padding of vectors                                               | Padding a 384-dim vector with 640 zeros severely distorts cosine distance metrics (`u·v / (                               | u                                                                                 |     | v   | )`), degrading search ranking accuracy. | Use native dimension models matching target dimension, or dimension-reduction (PCA/Matryoshka embeddings) if supported. |
| Unindexed vector scans (`ORDER BY embedding <=> query LIMIT K`) on large tables | Sequential scans degrade rapidly as document chunk counts grow past 10,000 rows.                                          | Define an `hnsw` or `ivfflat` index on `embeddings(embedding vector_cosine_ops)`. |
| Mismatched dimension runtime calls                                              | PostgreSQL will immediately throw error `different vector dimensions` if query vector length does not match table schema. | Strict dimension validation in `embedding.service.js` before SQL execution.       |

## Stack Patterns by Variant

**If using Local Ollama:**

- Model: `bge-large-en-v1.5` or `mxbai-embed-large`
- Dimension: 1024
- Rationale: High retrieval accuracy, natively matches `dimensions: 1024` in schema.

**If using Cloud Google GenAI:**

- Model: `text-embedding-004`
- Dimension: 768 (or 1024 via projection/Matryoshka if supported)
- Rationale: High multilingual performance for Gujarati/English health queries.

## Version Compatibility

| Package A            | Compatible With             | Notes                                                   |
| -------------------- | --------------------------- | ------------------------------------------------------- |
| `drizzle-orm@0.45.2` | `pg@8.20.0` / PostgreSQL 16 | Full support for pgvector `vector` column type.         |
| `pgvector` extension | PostgreSQL 16               | Supported in Docker container `pgvector/pgvector:pg16`. |

---

_Stack research for: PostgreSQL pgvector & Clinical Embedding Infrastructure_
_Researched: 2026-09-22_
