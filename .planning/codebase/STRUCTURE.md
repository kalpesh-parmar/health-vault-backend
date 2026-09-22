---
last_mapped_commit: 5990753ce6dc9c473e6209c959d9ebf4a4572b33
last_mapped_at: 2026-09-22T14:59:52+05:30
---

# Codebase Structure

**Analysis Date:** 2026-09-22

## Directory Layout

```text
health-vault-backend/
├── .agent/                 # GSD automation agents, workflows, and skills
├── .github/                # GitHub workflows and issue/PR templates
├── .husky/                 # Git hooks (pre-commit, commit-msg)
├── ai-service/             # Auxiliary Python FastAPI ML microservice
│   ├── app/
│   │   ├── api/v1/         # FastAPI route controllers (ocr, voice, chat, rag)
│   │   ├── core/           # Errors, logging, lifecycle
│   │   ├── models/         # Pydantic request/response schemas
│   │   └── services/       # ML pipelines (IndicTrans2, PaddleOCR, Whisper)
│   ├── deployment/         # Service deployment configs
│   ├── tests/              # Pytest test suite
│   ├── Dockerfile          # Python microservice container
│   └── requirements.txt    # Python dependencies
├── drizzle/                # Drizzle Kit SQL migrations
├── src/                    # Primary Node.js API application source
│   ├── api-docs/           # OpenAPI / Swagger YAML specifications
│   ├── clients/            # Outbound API clients (Ollama, AI Service, OAuth)
│   ├── configs/            # Configuration loaders (env, db, firebase, swagger)
│   ├── constants/          # Application message strings, errors, keywords
│   ├── controllers/        # Thin Express request handlers
│   ├── enums/              # Shared enumeration definitions
│   ├── exceptions/         # Custom AppError subclasses
│   ├── helpers/            # Response formatting and normalization helpers
│   ├── i18n/               # Localization strings (Gujarati, Hindi, English)
│   ├── jobs/               # Background scheduled cron tasks and sweepers
│   ├── middlewares/        # Express middleware chain (auth, upload, validation)
│   ├── models/             # Drizzle PostgreSQL schema definitions
│   ├── prompt/             # Raw text templates for AI prompts
│   ├── repositories/       # Data access repositories (Drizzle queries)
│   ├── resources/          # Static assets and templates
│   ├── routes/             # Express route declarations
│   ├── scripts/            # Database and maintenance utilities
│   ├── services/           # Domain business logic layer
│   │   ├── ai/             # AI core (OCR, onboarding, RAG, classifier)
│   │   ├── queue/          # In-process resilient document queue
│   │   └── sse/            # Server-Sent Events bus and adapters
│   ├── utils/              # General utility helpers (JWT, dates, tokens)
│   ├── validations/        # Zod request validation schemas
│   └── server.js           # Main Express server entry point
├── tests/                  # Jest test suite
│   ├── unit/               # Unit test specifications
│   └── setup.js            # Jest test environment setup
├── uploads/                # Temporary local upload directory
├── docker-compose.yml      # Local dev orchestration (PostgreSQL pgvector & ai-service)
├── Dockerfile              # Production Node container definition
├── drizzle.config.js       # Drizzle Kit configuration
├── eslint.config.js        # ESLint flat configuration
├── jest.config.js          # Jest configuration
└── package.json            # Project manifest and scripts
```

## Directory Purposes

**`src/api-docs/`:**

- Purpose: OpenAPI / Swagger documentation specs.
- Contains: Domain-specific `.swagger.yaml` files served at `/swagger-ui`.
- Key files: `document.swagger.yaml`, `medication.swagger.yaml`, `ocr.swagger.yaml`.

**`src/configs/`:**

- Purpose: Environment initialization, database pool, security settings.
- Contains: Configuration wrappers reading `process.env`.
- Key files: `src/configs/env.js`, `src/configs/db.js`, `src/configs/security.js`.

**`src/constants/`:**

- Purpose: Centralized repository for all user-facing strings and error messages.
- Contains: Immutable message dictionaries to prevent inline hardcoded strings.
- Key files: `src/constants/messageConstants.js`, `src/constants/errorConstants.js`.

**`src/controllers/`:**

- Purpose: Thin HTTP layer handling requests, calling services, returning responses.
- Contains: Express handler functions.
- Key files: `src/controllers/document.controller.js`, `src/controllers/patient.controller.js`.

**`src/enums/`:**

- Purpose: Single source of truth for enumerated values matching PostgreSQL enums.
- Contains: Object freezes for gender, status, document types, OCR stages.
- Key files: `src/enums/userStatus.enum.js`, `src/enums/documentType.js`, `src/enums/ocrStatus.js`.

**`src/models/`:**

- Purpose: Database table schema definitions for Drizzle ORM.
- Contains: PostgreSQL table declarations, primary keys, foreign keys, indexes.
- Key files: `src/models/patient.js`, `src/models/document.js`, `src/models/documentIntelligence.js`.

**`src/repositories/`:**

- Purpose: Encapsulated database operations.
- Contains: Query building, filtering, mutations using Drizzle ORM.
- Key files: `src/repositories/patientRepository.js`, `src/repositories/documentRepository.js`.

**`src/services/`:**

- Purpose: Domain business logic and orchestration.
- Contains: Complex workflows, external AI calls, queue management, calculation logic.
- Key files: `src/services/document.service.js`, `src/services/ai/ocr/ocr.service.js`, `src/services/medication.service.js`.

**`src/validations/`:**

- Purpose: Request input schema validation using Zod.
- Contains: Schemas for request query, params, and body.
- Key files: `src/validations/uploadValidation.js`, `src/validations/patientValidation.js`.

## Key File Locations

**Entry Points:**

- `src/server.js`: Express API server entry point.
- `src/routes/index.route.js`: Root route aggregator and health checks.
- `ai-service/app/main.py`: Python AI FastAPI entry point.

**Configuration:**

- `src/configs/env.js`: Central environment variable parser and validator.
- `src/configs/db.js`: PostgreSQL connection pool and Drizzle instance.
- `drizzle.config.js`: Database migration configuration.

**Core Logic:**

- `src/services/queue/documentQueue.service.js`: Background document processing queue.
- `src/services/ai/ocr/ocr.service.js`: OCR extraction engine.
- `src/services/ai/chat/onboarding/onboardingStateMachine.js`: Deterministic onboarding sequence.
- `src/services/medication.service.js`: Medication compliance and dosage scheduling.

**Testing:**

- `jest.config.js`: Jest runner configuration.
- `tests/setup.js`: Test environment environment mock definitions.
- `tests/unit/`: Unit tests for utilities, parsers, and services.

## Naming Conventions

**Files:**

- Controllers: `<domain>.controller.js` (e.g. `patient.controller.js`)
- Services: `<domain>.service.js` (e.g. `patient.service.js`)
- Repositories: `<domain>.repository.js` (e.g. `dashboard.repository.js`) or `<domain>Repository.js` (historical)
- Validations: `<domain>.validation.js` (e.g. `ocr.validation.js`) or `<domain>Validation.js`
- Routes: `<domain>.route.js` (e.g. `document.route.js`)
- Swagger Docs: `<domain>.swagger.yaml` (e.g. `document.swagger.yaml`)
- Models: `<domain>.js` (e.g. `patient.js`, `document.js`)
- Unit Tests: `<feature>.test.js` in `tests/unit/`

**Directories:**

- Plural lower-case directory names for architecture layers: `src/controllers`, `src/services`, `src/models`, `src/repositories`, `src/validations`, `src/routes`.

## Where to Add New Code

**New API Endpoint:**

1. Declare Zod validation schema in `src/validations/<domain>.validation.js`.
2. Add route definition in `src/routes/<domain>.route.js` with `validateRequest()` middleware.
3. Implement thin handler in `src/controllers/<domain>.controller.js`.
4. Implement business logic in `src/services/<domain>.service.js`.
5. Add or extend database queries in `src/repositories/<domain>.repository.js`.
6. Document endpoint in `src/api-docs/<domain>.swagger.yaml`.
7. Add unit tests in `tests/unit/<domain>.test.js`.

**New Database Table / Field:**

1. Define table schema or column in `src/models/<domain>.js`.
2. Generate migration via `npm run db:generate`.
3. Apply migration via `npm run db:migrate`.
4. Update or add repository methods in `src/repositories/<domain>.repository.js`.

**Shared Utility Function:**

- Common helpers belong in `src/utils/commonUtils.js` or a dedicated `src/utils/<name>Utils.js`.
- HTTP response formatting belongs in `src/helpers/generalResponse.js`.

## Special Directories

**`drizzle/`:**

- Purpose: Automatically generated SQL migration files.
- Generated: Yes (via `drizzle-kit generate`).
- Committed: Yes.

**`uploads/` / `tmp/`:**

- Purpose: Ephemeral scratch storage for file upload buffering and rasterization.
- Generated: Yes (at runtime).
- Committed: No (git-ignored).

**`ai-service/venv/`:**

- Purpose: Local Python virtual environment for the AI microservice.
- Generated: Yes.
- Committed: No (git-ignored).

---

_Structure analysis: 2026-09-22_
