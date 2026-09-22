# Architecture Research

**Domain:** Clinical Vector Embeddings & Semantic Retrieval
**Researched:** 2026-09-22
**Confidence:** HIGH

## Component Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Ingestion Path (Document Upload / OCR)                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│             Chunking & Preprocessing (`embedding.helper.js`)                 │
│  - `buildChunks`: OCR blocks, summaries, diagnosis, medications             │
│  - `stripThinking`: Removes internal chain-of-thought `<think>` tags        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 Embedding Service (`embedding.service.js`)                  │
│  - `embedText`: Calls client with fallback hierarchy                         │
│  - `normalizeVectorDimension`: Enforces target dimension (1024)             │
└──────────────────┬──────────────────────────────────┬───────────────────────┘
                   │                                  │
                   ▼                                  ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────────┐
│     Ollama Client (`ollamaClient.js`) │ │   AI Service (`aiServiceClient.js`)│
│  - `/api/embeddings` POST endpoint    │ │  - `/v1/embeddings` endpoint       │
│  - Returns native float array         │ │  - Returns native float array      │
└──────────────────┬────────────────────┘ └───────────────────┬───────────────┘
                   │                                  │
                   └──────────────────┬───────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│         Document Intelligence Repository (`documentIntelligenceRepository`) │
│  - Batch insert to `embeddings` table (1024-dimension vector column)        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PostgreSQL 16 `embeddings` Table                        │
│   id | user_id | chunk_id | source_type | embedding (1024) | model | ...    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▲
                                       │ Cosine Distance Search (`<=>`)
┌──────────────────────────────────────┴──────────────────────────────────────┐
│                  Query Path: Clinical RAG (`ragContext.service.js`)         │
│  User Chat Query ──> embedText(query) ──> pgvector Cosine Search ──> Top-K  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Details

### Ingestion Flow:

1. `documentPersistenceService` / `ocr.service.js` triggers `embeddingService.embedAndPersist()`.
2. Text chunks are generated via `buildChunks()` and cleaned of `<think>` tags via `stripThinking()`.
3. Chunks are persisted to `document_chunks` table via `txRepository.createChunks()`.
4. Each chunk's text is converted into an embedding array via `embedText()`.
5. If the generated vector dimension differs from `env.embeddingDim` (1024), `normalizeVectorDimension()` pads or truncates to ensure strict compliance with the PostgreSQL column definition.
6. Embedding records are inserted into `embeddings` table via `txRepository.createEmbeddings()`.

### Query Flow:

1. In `chat.service.js`, an incoming clinical query triggers `embeddingService.embedText(retrievalQuery)`.
2. The query embedding is passed to `ragContext.service.js:buildClinicalContext()`.
3. Repository executes cosine distance similarity query:
   ```sql
   SELECT chunk_id, content, 1 - (embedding <=> ${queryVector}) as similarity
   FROM embeddings
   WHERE user_id = ${userId}
   ORDER BY embedding <=> ${queryVector}
   LIMIT ${topK}
   ```
4. Retrieved chunk texts are passed as context to Gemini or Ollama for clinical synthesis.

## Key Design Patterns & Interfaces

1. **Adapter / Strategy Pattern in Client Layer:**
   - Standardize `ollamaClient.embeddings(text, model)` to mirror `aiServiceClient.embedText(text)`.
   - Implement automatic fallback: try primary configured provider (e.g. Ollama); if unreachable, failover to secondary provider (e.g. `aiServiceClient` or Google GenAI).

2. **Dimension Normalization Barrier:**
   - Placed in `src/helpers/embedding.helper.js`. Acts as a protective barrier before any database write or similarity query, ensuring vectors are strictly 1024 floats.

3. **Single Source of Truth Configuration:**
   - Centralize in `src/configs/env.js`:
     ```javascript
     embeddingDim: Number(process.env.EMBEDDING_DIM) || 1024,
     embeddingModel: process.env.EMBEDDING_MODEL || "bge-large-en-v1.5",
     ```

---

_Architecture research for: Clinical Vector Embeddings & Semantic Retrieval_
_Researched: 2026-09-22_
