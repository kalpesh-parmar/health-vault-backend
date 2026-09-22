---
last_mapped_commit: 5990753ce6dc9c473e6209c959d9ebf4a4572b33
last_mapped_at: 2026-09-22T14:59:52+05:30
---

# Coding Conventions

**Analysis Date:** 2026-09-22

## Naming Patterns

**Files:**

- Dot notation matching layer: `<name>.<layer>.js` (e.g. `patient.controller.js`, `patient.service.js`, `ocr.validation.js`).
- Swagger specifications: `<name>.swagger.yaml` in `src/api-docs/`.
- Test files: `<name>.test.js` in `tests/` or `tests/unit/`.

**Functions:**

- camelCase for functions and methods: `findById`, `createAndQueueJob`, `calculateNextOccurrence`.
- Descriptive verb-first naming: `verifyToken`, `sanitizePatient`, `extractEntities`.

**Variables:**

- camelCase for general variables and instances: `activeSession`, `structuredData`, `documentQueue`.
- UPPER_SNAKE_CASE for constants and frozen enum keys: `MAX_LOGIN_ATTEMPTS`, `FATAL_ERROR_CODES`, `DEFAULT_SUCCESS_MESSAGE`.

**Types & Schemas:**

- PascalCase for classes, Zod validation schemas, and exceptions: `AppError`, `NotFoundException`, `MedicalExtractionSchema`, `UploadDocumentSchema`.

## Code Style

**Formatting:**

- Prettier formatted (`.prettierrc`):
  - Print width: 100 characters
  - Semicolons: Required (`"semi": true`)
  - Quotes: Double quotes (`"singleQuote": false`)
  - Trailing commas: All (`"trailingComma": "all"`)

**Linting:**

- ESLint flat configuration (`eslint.config.js`):
  - Rule `unused-imports/no-unused-imports`: Error (unused imports automatically removed on format)
  - Rule `no-unused-vars`: Error (allows leading underscore prefix `^_` for unused parameters)
  - Rule `consistent-return`: Error
  - Rule `no-console`: Warning

## Import Organization

**Order:**

1. Core Node.js built-ins (`fs`, `path`, `http`, `child_process`).
2. External npm libraries (`express`, `zod`, `drizzle-orm`, `http-status-codes`).
3. Application configs and environment (`src/configs/env.js`, `src/configs/db.js`).
4. Constants and enums (`src/constants/`, `src/enums/`).
5. Exceptions and helpers (`src/exceptions/appError.js`, `src/helpers/generalResponse.js`).
6. Internal domain layers (repositories, services, clients).

**Rule on Imports:**

- **Zero Inline Imports**: ALL `require()` calls MUST reside at the top of the file. Never call `require()` inside functions or methods.
- **Circular Dependencies**: If moving an import creates a cycle, extract the shared logic into a standalone utility or helper rather than using lazy-loading inside a method.

**Path Aliases:**

- No path aliases are configured; relative paths are used (`../repositories/patientRepository`).

## Error Handling

**Patterns:**

- Custom typed exceptions extending `AppError` from `src/exceptions/appError.js`:

  ```javascript
  const { NotFoundException, InvalidRequestException } = require("../exceptions/appError");
  const { errorConstants } = require("../constants/errorConstants");

  if (!patientRecord) {
    throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
  }
  ```

- **No Hardcoded Messages**: Error messages MUST originate from `errorConstants` in `src/constants/errorConstants.js`. Never write `throw new Error("Patient not found")` or fallback patterns like `errorConstants.FOO || "fallback"`.
- **Centralized Error Response**: Handled by Express error handler middleware (`src/middlewares/errorHandler.js`), mapping `AppError` instances to standardized JSON payloads.

## Logging

**Framework:**

- Console wrapper (`console.log`, `console.error`, `console.warn`) combined with custom loggers:
  - `src/middlewares/apiLogger.js` for inbound HTTP traffic.
  - `src/configs/axiosLogger.js` for outbound HTTP requests.

**Patterns:**

- Errors in asynchronous jobs and sweeper tasks must log structured context:
  ```javascript
  console.error(`[QueueWorker] Failed processing job ${jobId}:`, error.message);
  ```

## Comments

**When to Comment:**

- Explain domain-specific healthcare constraints (e.g. medication frequency calculations, bilingual Gujarati transliteration nuances).
- Document complex regex patterns or mathematical formulas.
- Document asynchronous job state transitions and retry policies.

**JSDoc:**

- Used for major service functions and complex repository queries to document parameter types and returned Drizzle shapes.

## Function Design

**Size:**

- Single Responsibility Principle: Keep functions focused on a discrete operation.
- Heavy orchestration in services is broken into modular helpers (e.g. `src/services/ai/ocr/` decomposes preprocessing, inference, parsing, and caching).

**Parameters:**

- Functions with more than 2-3 arguments accept a single destructured options object:
  ```javascript
  async function processDocumentJob({ jobId, fileKey, userId, options }) { ... }
  ```

**Return Values:**

- Services return plain JavaScript objects or arrays (never Express `res` objects).
- Repositories return Drizzle entity rows or null.

## Module Design

**Exports:**

- CommonJS functional export style:
  ```javascript
  module.exports = {
    methodA,
    methodB,
  };
  ```
- Class exports for models, error classes, and state machines:
  ```javascript
  module.exports = { AppError, NotFoundException };
  ```

**Barrel Files:**

- Used selectively in `src/services/ai/index.js`, `src/validations/index.js`, and `src/clients/index.js` to simplify imports.

---

_Convention analysis: 2026-09-22_
