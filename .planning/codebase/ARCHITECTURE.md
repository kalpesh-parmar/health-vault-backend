---
last_mapped_commit: 5990753ce6dc9c473e6209c959d9ebf4a4572b33
last_mapped_at: 2026-09-22T14:59:52+05:30
---

# Architecture

**Analysis Date:** 2026-09-22

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Mobile Client / Web Frontends                      │
├───────────────────────────────┬─────────────────────────────────────────────┤
│         HTTP / REST           │             Server-Sent Events (SSE)        │
└───────────────┬───────────────┴───────────────────────┬─────────────────────┘
                │                                       │
                ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Express API Gateway (`src/server.js`)                 │
│    Helmet, RateLimiter, CORS, ApiLogger, Auth Middleware, Zod Validation    │
├───────────────────┬───────────────────┬───────────────────┬─────────────────┤
│   Auth & Patient  │   Document & OCR  │    Medications    │   AI & Chat RAG │
│  `src/controllers/│ `src/controllers/ │ `src/controllers/ │`src/controllers/│
│    patient.*`     │    document.*`    │   medication.*`   │      ocr.*`     │
└─────────┬─────────┴─────────┬─────────┴─────────┬─────────┴────────┬────────┘
          │                   │                   │                  │
          ▼                   ▼                   ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Domain Services Layer (`src/services/`)            │
│  - Document Orchestrator (`document.service.js`, `ocr.service.js`)          │
│  - Multi-stage OCR Pipeline (`src/services/ai/ocr/ocr.service.js`)          │
│  - MedGemma Classifier (`src/services/ai/classifier/`)                      │
│  - Deterministic Onboarding Engine (`src/services/ai/chat/onboarding/`)     │
│  - RAG & Context Builder (`src/services/ai/chat/ragContext.service.js`)     │
│  - Medication & Cron Engine (`src/services/medication.service.js`)          │
│  - Storage Abstraction (`src/services/objectStorage.service.js`)            │
└─────────┬───────────────────┬───────────────────┬──────────────────┬────────┘
          │                   │                   │                  │
          ▼                   ▼                   ▼                  ▼
┌───────────────────────────────────────┐ ┌───────────────────────────────────┐
│     Repositories (`src/repositories/`)│ │     External AI & Microservices   │
│  - documentRepository.js              │ │  - Python FastAPI (`ai-service/`) │
│  - documentIntelligenceRepository.js  │ │  - Google GenAI SDK (Gemini)      │
│  - patientRepository.js               │ │  - Ollama Daemon (Local Qwen)     │
│  - medicationRepository.js            │ │  - Firebase Admin SDK             │
└──────────────────┬────────────────────┘ └───────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PostgreSQL 16 + pgvector Database                       │
│      Drizzle ORM Schemas (`src/models/`): patients, documents, sessions,     │
│       document_chunks, embeddings (1024-dim), medications, reminders        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component                     | Responsibility                                                                                    | File                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Server Entry Point**        | Initializes Express, connects DB pool, registers cron jobs, boots SSE bus and recovery sweeper    | `src/server.js`                                                               |
| **API Router**                | Mounts domain sub-routers (`/auth`, `/documents`, `/patient`, `/medications`, `/v1`, `/sse`)      | `src/routes/index.route.js`                                                   |
| **Auth Middleware**           | Verifies bearer JWT, checks user status, binds authenticated user/session to `req.auth`           | `src/middlewares/authMiddleware.js`                                           |
| **Request Validator**         | Validates incoming params, query, and body using Zod schemas before controllers run               | `src/middlewares/validateRequest.js`                                          |
| **Document Processing Queue** | Asynchronous resilient job queue executing multi-stage document processing                        | `src/services/queue/documentQueue.service.js`                                 |
| **Document OCR Service**      | Orchestrates PDF rasterization, image preprocessing, multi-engine OCR, and JSON entity parsing    | `src/services/ai/ocr/ocr.service.js`                                          |
| **MedGemma Classifier**       | Pre-classifies uploaded files as medical vs non-medical documents before full extraction          | `src/services/ai/classifier/medicalDocumentClassifier.service.js`             |
| **Onboarding State Machine**  | Strict backend-driven deterministic state machine for bilingual conversational patient onboarding | `src/services/ai/chat/onboarding/onboardingStateMachine.js`                   |
| **RAG Context Service**       | Performs vector similarity search via pgvector and builds clinical LLM prompts                    | `src/services/ai/chat/ragContext.service.js`                                  |
| **Medication Cron & Engine**  | Generates dose occurrences, checks refill levels, and triggers FCM alerts                         | `src/services/medication.service.js`, `src/jobs/medicationCron.js`            |
| **Object Storage Adapter**    | Abstracts cloud file storage switching dynamically between AWS S3 and GCP Cloud Storage           | `src/services/objectStorage.service.js`, `src/services/gcpStorage.service.js` |
| **SSE Event Bus**             | Dispatches real-time pipeline milestone progress and updates to client streams                    | `src/services/sse/ocrProgressBus.js`, `src/services/sse/sharedSseBus.js`      |

## Pattern Overview

**Overall:** Clean Architecture / Layered Modular Monolith with an auxiliary Python AI Microservice.

**Key Characteristics:**

- **Strict Layer Decoupling**: Route → Validation Middleware → Controller → Service → Repository → Model → DB.
- **Thin Controllers**: Controllers read validated inputs, invoke exactly one service method, and format responses via helper functions.
- **Service Orchestration**: Complex cross-cutting business rules (e.g. upload → classification → OCR → RAG indexing) are orchestrated inside services.
- **Functional Repositories**: Pure database access logic using Drizzle ORM queries, avoiding direct model access in services.

## Layers

**Routes & Validations:**

- Purpose: HTTP routing, parameter parsing, and schema validation.
- Location: `src/routes/`, `src/validations/`
- Contains: Express route definitions and Zod schemas.
- Depends on: Middlewares (`validateRequest`, `authMiddleware`).
- Used by: Express application (`src/server.js`).

**Controllers:**

- Purpose: Thin HTTP layer translating HTTP requests into domain service calls.
- Location: `src/controllers/`
- Contains: Request parameter extraction and response formatting with `successResponse` / `errorResponse`.
- Depends on: Services, response helpers (`src/helpers/generalResponse.js`), HTTP status codes.
- Used by: Routes.

**Services:**

- Purpose: Core domain logic, business validations, external API interactions, multi-service orchestration.
- Location: `src/services/`
- Contains: Plain JavaScript functions/classes handling business logic.
- Depends on: Repositories, AI clients, external SDKs, exceptions (`src/exceptions/appError.js`).
- Used by: Controllers, cron jobs, background queue workers.

**Repositories:**

- Purpose: Data access layer encapsulating Drizzle ORM queries and SQL operations.
- Location: `src/repositories/`
- Contains: CRUD operations, complex joins, vector similarity queries.
- Depends on: Drizzle models (`src/models/`), Drizzle instance (`src/configs/db.js`).
- Used by: Services.

**Models:**

- Purpose: PostgreSQL schema definitions via Drizzle ORM.
- Location: `src/models/`
- Contains: Drizzle table definitions, pgEnum declarations, table constraints, indexes.
- Depends on: `drizzle-orm/pg-core`.
- Used by: Repositories, Drizzle Kit migrations.

## Data Flow

### Primary Request Path (Document Upload & Processing)

1. Client uploads document via `POST /documents/upload` (`src/routes/document.route.js:15`).
2. Multer middleware streams file to temporary storage and validates MIME type (`src/middlewares/upload.js`).
3. Zod validation validates request headers/body (`src/validations/uploadValidation.js`).
4. Controller invokes orchestrator method `documentService.createAndQueueJob()` (`src/controllers/document.controller.js`).
5. Service uploads file to AWS S3 or GCP Storage and persists job in `document_processing_jobs` table (`src/services/document.service.js`).
6. Background queue worker picks up job and runs stages: `PREPROCESS` → `CLASSIFY` → `OCR` → `EXTRACT` → `EMBED` (`src/services/queue/documentQueue.service.js`).
7. Real-time progress updates are emitted over SSE stream to the mobile app (`src/services/sse/ocrProgressBus.js`).

### AI Onboarding Flow

1. Client sends message via `POST /v1/onboarding-chat` (`src/routes/ocr.route.js`).
2. Controller delegates to `onboardingService.processMessage()` (`src/services/ocr.service.js`).
3. State machine verifies current patient onboarding state in `user_onboarding` table (`src/services/ai/chat/onboarding/onboardingStateMachine.js`).
4. LLM extracts entities (name, DOB, gender, blood group, allergies) from unstructured user text without determining step transitions.
5. Backend updates onboarding state and returns next deterministic question to client.

**State Management:**

- Stateless HTTP request handling; session tokens tracked in `sessions` table.
- Real-time pipeline state tracked in `document_processing_jobs` table with granular heartbeat checkpoints and recovery sweeper on restart.

## Key Abstractions

**Document Processing Queue (`documentQueue.service.js`):**

- Purpose: Resilient in-process job queue with database persistence, heartbeat tracking, and automatic boot recovery.
- Location: `src/services/queue/documentQueue.service.js`
- Pattern: Producer-Consumer queue with transactional state checkpoints.

**Object Storage Provider (`objectStorage.service.js`):**

- Purpose: Unified interface for S3 and GCP storage operations.
- Pattern: Strategy / Adapter pattern switching providers via `STORAGE_PROVIDER`.

**Response Helper (`generalResponse.js`):**

- Purpose: Standardized API response format for all success and error scenarios.
- Pattern: Factory helper (`successResponse`, `errorResponse`, `paginatedSuccessResponse`).

## Entry Points

**Main HTTP API:**

- Location: `src/server.js`
- Triggers: Node.js process launch (`npm run dev`, `npm start`).
- Responsibilities: Bootstraps Express, mounts routes, starts cron tasks, recovers orphaned background jobs.

**Python AI Service:**

- Location: `ai-service/app/main.py`
- Triggers: Uvicorn ASGI server launch (`uvicorn app.main:app`).
- Responsibilities: Serves specialized ML models (PaddleOCR, IndicTrans2, Whisper).

## Architectural Constraints

- **CommonJS Only**: Plain JavaScript CommonJS (`require` / `module.exports`) across all `src/` code. No TypeScript.
- **Strict Import Hoisting**: All `require` statements must live at the top of files; in-method/inline requires are prohibited.
- **Constants for Messaging**: All response messages and error strings must be referenced from `src/constants/messageConstants.js` and `src/constants/errorConstants.js`.
- **Enum Consistency**: All typed values (status, gender, file types) must match DB schema enums defined in `src/enums/`.
- **Soft Deletion**: Patients, documents, sessions, and medications use `softDelete` booleans to maintain medical compliance and audit logs.
- **Deterministic AI State Transitions**: The LLM is strictly used for extraction and translation; state machine transitions are purely backend-enforced.

## Anti-Patterns

### Inline Lazy Loading (`require` inside functions)

**What happens:** Developers place `require()` calls inside functions to bypass circular dependency errors.
**Why it's wrong:** Masks architectural circular dependencies, prevents early static validation, and impairs maintainability.
**Do this instead:** Hoist all `require()` calls to the file header. If a cycle exists, refactor the shared dependency into a separate module.

### Controller Direct Database Access

**What happens:** Controllers importing Drizzle `db` or calling repositories directly.
**Why it's wrong:** Violates Clean Architecture separation of concerns and bypasses domain validation in services.
**Do this instead:** Controllers must call exactly one service method; services interact with repositories.

### Dynamic LLM State Transitions

**What happens:** Letting an LLM decide the next onboarding step or routing logic.
**Why it's wrong:** Produces non-deterministic behavior, loops, or missed clinical fields.
**Do this instead:** Maintain state transitions strictly in `onboardingStateMachine.js`.

## Error Handling

**Strategy:** Centralized exception handling wrapping domain errors in `AppError` subclasses.

**Patterns:**

- Services throw typed exceptions: `NotFoundException`, `InvalidRequestException`, `UnauthorizedException`, `SessionExpiredException`, `NonMedicalDocumentException`.
- Document processing marks errors as either fatal or retryable (`AppError.retryable`), determining whether the pipeline retries or aborts.
- Central middleware `src/middlewares/errorHandler.js` intercepts all unhandled errors and returns standardized JSON responses.

## Cross-Cutting Concerns

**Logging:** Request logging via `src/middlewares/apiLogger.js` and outbound HTTP logging via `src/configs/axiosLogger.js`.
**Validation:** Request body, param, and query validation enforced via Zod in `src/middlewares/validateRequest.js`.
**Authentication:** JWT Bearer token authentication verified in `src/middlewares/authMiddleware.js`.
**CORS & Security:** Helmet and RateLimiter configured in `src/configs/security.js`.

---

_Architecture analysis: 2026-09-22_
