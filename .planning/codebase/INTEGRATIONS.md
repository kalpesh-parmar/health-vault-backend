---
last_mapped_commit: 5990753ce6dc9c473e6209c959d9ebf4a4572b33
last_mapped_at: 2026-09-22T14:59:52+05:30
---

# External Integrations

**Analysis Date:** 2026-09-22

## APIs & External Services

**AI Inference & LLM Providers:**

- **Google GenAI / Gemini API** - Clinical extraction, medical summarization in Gujarati/English, RAG question answering
  - SDK/Client: `@google/genai` and `@google/generative-ai` (`src/services/ai/clients/aiClient.service.js`)
  - Auth: `AI_API_KEY` env variable
  - Endpoint: `https://generativelanguage.googleapis.com` (`AI_BASE_URL`)
- **Ollama Local Engine** - Local offline LLM fallback (`qwen3:32b`, `medgemma:4b`)
  - Client: Custom HTTP client (`src/clients/ollamaClient.js`)
  - Auth: None (local daemon / internal network)
  - Endpoint: `OLLAMA_URL` or `AI_BASE_URL` (default `http://localhost:11434`)
- **Python FastAPI AI Microservice** - Offloaded PaddleOCR, IndicTrans2 translation, Whisper voice transcription, TTS, and sentence embeddings
  - Client: Axios wrapper (`src/clients/aiServiceClient.js`)
  - Auth: Internal microservice communication
  - Endpoint: `AI_SERVICE_URL` (default `http://127.0.0.1:8000`)

**OAuth & Social Providers:**

- **Microsoft Identity Platform** - Social login authentication
  - Client: `src/clients/microsoftClient.js`
  - Auth: `MICROSOFT_BASE_URL` (default `https://login.microsoftonline.com`)
- **Facebook Graph API** - Social login authentication
  - Client: `src/clients/facebookClient.js`
  - Auth: `FACEBOOK_GRAPH_BASE_URL` (default `https://graph.facebook.com`)

**Billing & Payments:**

- **Paddle** - Payment processing and subscription management
  - SDK/Client: `@paddle/paddle-node-sdk`
  - Auth: Configured via Paddle API keys when billing is enabled

**Email & Notifications:**

- **SMTP Gateway (Nodemailer)** - Email dispatch for password resets, alerts, and OTPs
  - SDK/Client: `nodemailer` (`src/services/email.service.js`)
  - Auth: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`
- **Firebase Cloud Messaging (FCM)** - Push notifications for medication reminders
  - SDK/Client: `firebase-admin` (`src/services/notification.service.js`, `src/services/notificationApi.service.js`)
  - Auth: Firebase Admin SDK credentials (`FIREBASE_CREDENTIALS_BASE64`)

## Data Storage

**Databases:**

- **PostgreSQL 16 with `pgvector` extension**
  - Connection: `DATABASE_URL` (e.g. `postgres://postgres:postgres@localhost:5432/health_vault`)
  - Pool Settings: `DB_POOL_MAX` (default 10), `DB_IDLE_TIMEOUT_MS` (default 30000)
  - Client: `pg` Pool (`src/configs/db.js`) with Drizzle ORM (`drizzle-orm/node-postgres`)
  - Vector dimensions: 1024-dimension vector embeddings table (`embeddings` in `src/models/documentIntelligence.js`)

**File Storage:**

- **Configuration-driven Hybrid Object Storage (`src/services/storage.service.js`, `src/services/objectStorage.service.js`, `src/services/gcpStorage.service.js`):**
  - Provider selector: `STORAGE_PROVIDER` (`auto` | `s3` | `gcp`)
  - **AWS S3**: `@aws-sdk/client-s3` (`AWS_BUCKET_NAME`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
  - **GCP Cloud Storage**: `@google-cloud/storage` (`GCP_PROJECT_ID`, `GCP_STORAGE_BUCKET`, `GCP_CREDENTIALS_BASE64`)
  - **Local filesystem backup**: `uploads/` directory for temporary multipart handling before cloud upload

**Caching:**

- **In-Memory & Database Cache:**
  - AI Context Cache: Database table `ai_context_cache` (`src/models/documentIntelligence.js`)
  - In-process LRU/Map caching: `AI_CACHE_SIZE=64` for document classification and prompt responses
  - Distributed SSE Bus: `src/services/sse/sharedSseBus.js` for broadcasting SSE events across multiple instances

## Authentication & Identity

**Auth Provider:**

- **Hybrid (Firebase Admin + Custom JWT):**
  - **Mobile OTP Verification**: Firebase Admin SDK (`src/configs/firebase.js`, `FIREBASE_PROJECT_ID`, `FIREBASE_CREDENTIALS_BASE64`). Decodes mobile phone credentials and UID.
  - **JWT Tokens**: Custom tokens issued by `src/utils/jwtUtils.js`:
    - Access Token: Signed with `JWT_SECRET`, default 15m expiration (`JWT_ACCESS_EXPIRES_IN`).
    - Refresh Token: Stored hashed (`bcrypt`) in `sessions` table, default 7d expiration (`JWT_REFRESH_EXPIRES_IN`).
    - Session tracking: `sessions` table tracks `refreshTokenHash`, `refreshTokenExpiresAt`, `deviceToken`, and `isActive`.
  - **Account Lockout Protection**: `MAX_LOGIN_ATTEMPTS=3` tracked in `login_attempts` table (`src/models/loginAttempts.js`).

## Monitoring & Observability

**Error Tracking:**

- Custom centralized error handling (`src/middlewares/errorHandler.js`, `src/exceptions/appError.js`) logging structured errors to stdout/stderr. No external APM (e.g. Sentry/Datadog) currently integrated.

**Logs:**

- HTTP Request Logger: Custom middleware `src/middlewares/apiLogger.js` (enabled via `ENABLE_API_LOGS=true`).
- Axios Outbound Logger: `src/configs/axiosLogger.js` intercepts outbound requests to external APIs.
- Console Output: Standard structured terminal logs.

## CI/CD & Deployment

**Hosting:**

- Containerized deployment ready:
  - Node API: `Dockerfile` (Alpine Linux base)
  - Python AI Service: `ai-service/Dockerfile`
  - Compose Orchestration: `docker-compose.yml` (pgvector database + ai-service)

**CI Pipeline & Git Quality Gates:**

- Pre-commit hooks: Husky (`.husky/pre-commit`), executing `lint-staged` (`eslint --fix`, `prettier --write`).
- Commit message verification: Commitlint (`.husky/commit-msg`) enforcing conventional commits.

## Environment Configuration

**Required Environment Variables:**

- Core App: `PORT`, `NODE_ENV`, `DATABASE_URL`
- Auth & Security: `JWT_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `FIREBASE_PROJECT_ID`, `FIREBASE_CREDENTIALS_BASE64`
- Storage: `STORAGE_PROVIDER`, `AWS_BUCKET_NAME` / `GCP_STORAGE_BUCKET`, corresponding credentials
- AI / OCR: `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY` (if using hosted Gemini), `AI_SERVICE_URL`

**Secrets Location:**

- Local development: `.env` file (git-ignored, template in `.env.example`).
- Production: Container environment variables or cloud secret managers (AWS Secrets Manager, GCP Secret Manager).

## Webhooks & Callbacks

**Incoming:**

- None registered currently (third-party webhooks for Paddle or SMS callbacks are not yet mounted).

**Outgoing / Streaming:**

- Server-Sent Events (SSE):
  - `GET /sse/connect` - General client notification stream (`src/routes/sse.route.js`)
  - `GET /sse/ocr-progress` - Real-time OCR document processing milestone updates (`src/services/sse/ocrProgressBus.js`)

---

_Integration audit: 2026-09-22_
