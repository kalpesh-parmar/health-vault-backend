---
last_mapped_commit: 5990753ce6dc9c473e6209c959d9ebf4a4572b33
last_mapped_at: 2026-09-22T14:59:52+05:30
---

# Codebase Concerns

**Analysis Date:** 2026-09-22

## Tech Debt

**Inconsistent Repository and Validation File Naming:**

- Issue: AGENTS.md mandates strict dot-notation `<name>.<layer>.js` (e.g. `patient.repository.js`, `patient.validation.js`), but multiple files historically use camelCase without dots:
  - Repositories: `src/repositories/patientRepository.js`, `src/repositories/documentRepository.js`, `src/repositories/chatSessionRepository.js` vs `src/repositories/dashboard.repository.js`.
  - Validations: `src/validations/patientValidation.js`, `src/validations/uploadValidation.js` vs `src/validations/ocr.validation.js`.
- Files: `src/repositories/*.js`, `src/validations/*.js`
- Impact: Inconsistent import paths and cognitive overhead when navigating layers.
- Fix approach: Normalize all repository and validation filenames to `<name>.<layer>.js` in a planned refactor pass.

**Oversized God Services:**

- Issue: Several services have accumulated massive responsibility spanning multiple domains:
  - `src/services/ai/chat/onboarding.service.js` (2,496 lines)
  - `src/services/ai/chat/chat.service.js` (2,154 lines)
  - `src/services/ai/ocr/ocr.service.js` (2,020 lines)
  - `src/services/ocr.service.js` (1,381 lines)
- Files: `src/services/ai/chat/`, `src/services/ai/ocr/ocr.service.js`, `src/services/ocr.service.js`
- Impact: High risk of regression when modifying prompt parsing, session handling, or OCR fallback. Hard to unit test thoroughly.
- Fix approach: Decompose into focused sub-services (e.g., separate OCR preprocessing, OCR model inference, clinical entity parsing, and RAG ingestion into dedicated submodules).

**Dual OCR Orchestration Layers:**

- Issue: Both `src/services/ocr.service.js` and `src/services/ai/ocr/ocr.service.js` exist. `src/services/ocr.service.js` imports `ocrService` from `ai/ocr/ocr.service.js` while also orchestrating onboarding and chat actions. Line 1390 contains: `// TODO: move onboarding status/history out of ocr.service.js`.
- Files: `src/services/ocr.service.js:1390`, `src/services/ai/ocr/ocr.service.js`
- Impact: Confusing division of labor between `ocr.service.js` and `ai/ocr/ocr.service.js`.
- Fix approach: Move onboarding conversational handlers out of `ocr.service.js` into `onboarding.service.js`, leaving `ocr.service.js` solely responsible for OCR job orchestration.

**Vector Embedding Dimension Mismatch in Documentation vs Code:**

- Issue: In `src/models/documentIntelligence.js:126`, the schema defines `vector("embedding", { dimensions: 1024 })`, while code comments mention 384-dimension embeddings (sentence-transformers), and AGENTS.md Section 4 states 768-dimension vectors.
- Files: `src/models/documentIntelligence.js:7,126`, `AGENTS.md:Section 4`
- Impact: If embedding generation models change (`all-MiniLM-L6-v2` produces 384 dims, Gemini text-embedding produces 768 or 1024 dims), pgvector inserts fail with dimensionality mismatch errors.
- Fix approach: Document and enforce the standard embedding model and matching dimension (1024 or 768) across all layers and documentation.

## Known Bugs

**Hardcoded Error Strings in Auth Middleware:**

- Symptoms: `src/middlewares/authMiddleware.js` lines 10, 19, 23, 29, and 35 throw `new SessionExpiredException("User not found or session expired")` using an inline string rather than referencing `errorConstants.USER_NOT_FOUND_OR_SESSION_EXPIRED`.
- Files: `src/middlewares/authMiddleware.js:10,19,23,29,35`
- Trigger: Expired token, invalid token payload, or inactive user account.
- Workaround: None required by client (message string is returned), but violates the mandatory rule: "Messages come from constants."

**Gujarati Keywords Mislabeled as Hindi/Marathi:**

- Symptoms: In `src/constants/keywordDictionary.js:244,256`, comments note: `// TODO: mislabeled — this is Gujarati script, not Hindi/Marathi`.
- Files: `src/constants/keywordDictionary.js:244,256`
- Trigger: Clinical dictionary lookup during multi-lingual OCR extraction.
- Workaround: Handled by fallback dictionaries, but classification tag is mislabeled.

## Security Considerations

**API Rate Limiting on Uploads:**

- Risk: DoS via high-frequency multipart PDF uploads triggering heavy CPU/GPU OCR extraction.
- Files: `src/configs/security.js`, `src/routes/document.route.js`
- Current mitigation: Global rate limiter `RATE_LIMIT_WINDOW_MS=900000` with `RATE_LIMIT_MAX=100`.
- Recommendations: Add route-specific rate limiting on `POST /documents/upload` and `POST /v1/ocr-extract` (e.g. max 5 uploads per minute per user).

**Temporary File Cleanup on Processing Crashes:**

- Risk: In-flight temporary files accumulating on disk in `uploads/` if the Node process crashes mid-rasterization.
- Files: `src/services/ai/ocr/ocr.service.js`, `src/jobs/documentJobSweeper.js`
- Current mitigation: Sweeper cleans up orphaned database job records, but orphaned disk files in `uploads/` or `tmp/` require periodic filesystem pruning.
- Recommendations: Add an automated disk file cleanup routine in `documentJobSweeper.js`.

## Performance Bottlenecks

**Multi-Page PDF Rasterization and OCR:**

- Problem: Large PDFs (up to 25 pages) rasterized into high-resolution images via `node-poppler` / `pdftoppm` before executing OCR.
- Files: `src/services/ai/ocr/ocr.service.js`
- Cause: Synchronous or high-concurrency image rendering and multi-engine fallback.
- Improvement path: Page-level parallelization is configured (`AI_PAGE_CONCURRENCY=4`), but streaming individual pages to OCR as soon as rendered will decrease time-to-first-token.

## Fragile Areas

**Bilingual Onboarding State Machine & Transliteration:**

- Files: `src/services/ai/chat/onboarding/onboardingStateMachine.js`, `src/services/ai/chat/onboarding.service.js`
- Why fragile: Handles phonetic Gujarati-to-English name transliteration, date parsing from conversational vernacular text, and strict step transitions. Any subtle change to prompt templates can alter entity extraction formats.
- Safe modification: Run `npm run test:i18n` and `npx jest tests/onboardingFlows.test.js` before and after modifying onboarding prompts or state logic.

**SSE Real-Time Progress Stream Across Clustered Instances:**

- Files: `src/services/sse/ocrProgressBus.js`, `src/services/sse/sharedSseBus.js`
- Why fragile: When scaling horizontally behind a load balancer, SSE clients connected to Instance A require Redis/PubSub event bridging to receive OCR progress updates triggered on Instance B.
- Test coverage: Covered by `tests/unit/sseStreamReliability.test.js`, but production clustering requires a shared Redis or Postgres LISTEN/NOTIFY adapter.

## Scaling Limits

**In-Memory Document Queue:**

- Current capacity: Single-instance in-memory concurrency (`src/services/queue/documentQueue.service.js`).
- Limit: Does not natively coordinate work among multiple Node.js horizontal cluster replicas without database-level row locking (`SELECT FOR UPDATE SKIP LOCKED`).
- Scaling path: Transition from internal memory queue to BullMQ (Redis-backed) or leverage PostgreSQL row locks.

## Dependencies at Risk

**Duplicated Google Generative AI SDKs:**

- Risk: Both `@google/genai` (`^2.7.0`) and `@google/generative-ai` (`^0.24.1`) are installed in `package.json`.
- Impact: Increased bundle size, potential confusion over which client wrapper is active in `src/services/ai/clients/`.
- Migration plan: Standardize on `@google/genai` and remove `@google/generative-ai`.

**System Binary Dependencies (`node-poppler`):**

- Risk: `node-poppler` relies on underlying system binaries (`pdftoppm`, `pdfinfo`). Missing binaries in minimal Linux environments cause silent runtime failures.
- Impact: Docker container must explicitly install `poppler-utils`.

## Test Coverage Gaps

**Social OAuth Authentication (`Microsoft` / `Facebook`):**

- What's not tested: Real authentication callback token exchange in `src/clients/microsoftClient.js` and `src/clients/facebookClient.js`.
- Risk: Third-party API payload changes or expiration handling going unnoticed.
- Priority: Medium.

**Horizontal SSE Redis PubSub Adapter:**

- What's not tested: Distributed event propagation across multiple running API server instances.
- Files: `src/services/sse/sharedSseBus.js`
- Risk: Event drops in multi-instance deployments.
- Priority: Medium.

---

_Concerns audit: 2026-09-22_
