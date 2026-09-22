---
last_mapped_commit: 5990753ce6dc9c473e6209c959d9ebf4a4572b33
last_mapped_at: 2026-09-22T14:59:52+05:30
---

# Technology Stack

**Analysis Date:** 2026-09-22

## Languages

**Primary:**

- JavaScript (Node.js runtime, ES2022+ syntax, CommonJS module system `require` / `module.exports`) - Backend API, controllers, services, repositories, migrations, tests (`src/`, `tests/`)

**Secondary:**

- Python (v3.10+) - AI Microservice (`ai-service/`), providing specialized OCR (PaddleOCR), Indic translation (IndicTrans2), language detection (FastText/GlotLID), speech-to-text (Whisper), and text-to-speech (TTS)
- SQL / PostgreSQL DDL - Drizzle schema definitions (`src/models/`), Drizzle migrations (`drizzle/`), and pgvector extensions

## Runtime

**Environment:**

- Node.js: v20.x – v23.x (Production container runs `node:20-alpine` via [Dockerfile](file:///d:/Health_Vault/health-vault-backend/Dockerfile); development supports Node v22/v23 with `--experimental-strip-types`)
- Python: v3.10+ (Containerized in [ai-service/Dockerfile](file:///d:/Health_Vault/health-vault-backend/ai-service/Dockerfile))

**Package Manager:**

- Node: npm (`package-lock.json` present)
- Python: pip (`requirements.txt` present in [ai-service/requirements.txt](file:///d:/Health_Vault/health-vault-backend/ai-service/requirements.txt))

## Frameworks

**Core:**

- Express.js `^5.2.1` - Web API framework, routing, HTTP middleware (`src/server.js`, `src/routes/index.route.js`)
- Drizzle ORM `^0.45.2` - Type-safe SQL query builder and schema manager (`src/configs/db.js`, `src/models/`)
- FastAPI `0.115.6` (Python) - High-performance ASGI microservice framework (`ai-service/app/main.py`)
- Uvicorn `0.34.0` (Python) - ASGI server for FastAPI

**Testing:**

- Jest `^30.4.2` - JavaScript unit and integration test runner (`jest.config.js`, `tests/`)
- Pytest (configured via `ai-service/pytest.ini`) - Python AI service test runner

**Build/Dev:**

- Nodemon `^3.1.11` - Hot-reloading server runner in development (`npm run dev`)
- Drizzle Kit `^0.31.10` - Database schema migrations generator and CLI (`drizzle.config.js`)
- ESLint `^9.39.2` (flat config format) - Code linting (`eslint.config.js`)
- Prettier `^3.6.2` - Code formatting (`.prettierrc`)
- Husky `^9.1.7` & lint-staged `^16.2.7` - Git pre-commit hooks (`.husky/`)
- Commitlint `^20.2.0` - Conventional commit validation (`commitlint.config.js`)

## Key Dependencies

**Critical:**

- `pg` `^8.20.0` - PostgreSQL connection pool client (`src/configs/db.js`)
- `zod` `^3.25.76` - Schema validation middleware for all request payloads (`src/validations/`)
- `jsonwebtoken` `^9.0.3` - Access token and refresh token signing/verification (`src/utils/jwtUtils.js`)
- `firebase-admin` `^13.10.0` - Firebase mobile OTP authentication verification (`src/configs/firebase.js`)
- `tesseract.js` `^7.0.0` - Node-level OCR engine fallback (`src/services/ai/ocr/ocr.service.js`)
- `node-poppler` `^11.0.0` & `pdf-parse` `^2.4.5` - PDF to image conversion and text extraction
- `sharp` `^0.34.5` - High-performance image transformation and optimization for OCR preprocessing

**Infrastructure & Services:**

- `@aws-sdk/client-s3` `^3.1038.0` & `@aws-sdk/s3-request-presigner` `^3.1039.0` - AWS S3 document upload and presigned URL generation (`src/services/objectStorage.service.js`)
- `@google-cloud/storage` `^7.19.0` - Google Cloud Storage document storage provider (`src/services/gcpStorage.service.js`)
- `@google/genai` `^2.7.0` & `@google/generative-ai` `^0.24.1` - Google Gemini integration for OCR extraction, summarization, and RAG chat (`src/services/ai/clients/aiClient.service.js`)
- `axios` `^1.18.1` - HTTP client for cross-service calls (FastAPI AI service, Ollama, OAuth providers)
- `node-cron` `^4.2.1` - Scheduled background cron tasks for medication alerts and job sweeping (`src/jobs/`, `src/services/cron.service.js`)
- `multer` `^2.1.1` - Multipart/form-data upload handling (`src/middlewares/upload.js`)
- `helmet` `^8.1.0` & `express-rate-limit` `^8.4.1` - HTTP security headers and rate limiting (`src/configs/security.js`)
- `swagger-ui-express` `^5.0.1` & `swagger-jsdoc` `^6.3.0` - OpenAPI / Swagger documentation (`src/configs/swagger.js`, `src/api-docs/`)

## Configuration

**Environment:**

- Managed via `dotenv` `^17.4.2` (`.env`, template documented in [.env.example](file:///d:/Health_Vault/health-vault-backend/.env.example))
- Central typed loader with validation and defaults: [src/configs/env.js](file:///d:/Health_Vault/health-vault-backend/src/configs/env.js)
- Critical configuration categories:
  - Database: `DATABASE_URL`, `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`
  - Auth/JWT: `JWT_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `MAX_LOGIN_ATTEMPTS`
  - Storage: `STORAGE_PROVIDER` (`auto` | `s3` | `gcp`), AWS/GCP credentials
  - AI & OCR: `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY`, `AI_SERVICE_URL`, `USE_EXTERNAL_AI_SERVICE`, `MEDGEMMA_MODEL`

**Build & Tooling:**

- [drizzle.config.js](file:///d:/Health_Vault/health-vault-backend/drizzle.config.js) - Schema glob `src/models/*.js`, migration folder `drizzle/`
- [eslint.config.js](file:///d:/Health_Vault/health-vault-backend/eslint.config.js) - Flat config, unused-imports enforcement, Jest global detection
- [.prettierrc](file:///d:/Health_Vault/health-vault-backend/.prettierrc) - Print width 100, double quotes, semicolons, trailing commas
- [jest.config.js](file:///d:/Health_Vault/health-vault-backend/jest.config.js) - Node environment, setup file `tests/setup.js`
- [commitlint.config.js](file:///d:/Health_Vault/health-vault-backend/commitlint.config.js) - Conventional commit rules
- [docker-compose.yml](file:///d:/Health_Vault/health-vault-backend/docker-compose.yml) - Orchestration for `pgvector/pgvector:pg16` and `ai-service` container

## Platform Requirements

**Development:**

- Node.js v20+ / npm v10+
- Python 3.10+ (for running `ai-service` locally or via Docker)
- PostgreSQL 16 with `pgvector` extension enabled
- Local binaries: Poppler utilities (`pdftoppm`) for PDF processing; Tesseract OCR binaries if using local Node Tesseract

**Production:**

- Linux container execution (`Dockerfile` Node alpine base, `ai-service/Dockerfile` Python base)
- PostgreSQL 16+ instance with `vector` extension
- Managed Object Storage (AWS S3 or GCP Cloud Storage)
- External or local AI inference (Google GenAI API, Ollama daemon, or containerized FastAPI AI service)

---

_Stack analysis: 2026-09-22_
