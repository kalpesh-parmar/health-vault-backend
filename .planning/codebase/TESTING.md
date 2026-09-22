---
last_mapped_commit: 5990753ce6dc9c473e6209c959d9ebf4a4572b33
last_mapped_at: 2026-09-22T14:59:52+05:30
---

# Testing Patterns

**Analysis Date:** 2026-09-22

## Test Framework

**Runner:**

- Jest `^30.4.2`
- Config: [jest.config.js](file:///d:/Health_Vault/health-vault-backend/jest.config.js)
- Environment: Node.js (`testEnvironment: "node"`)
- Global Setup: [tests/setup.js](file:///d:/Health_Vault/health-vault-backend/tests/setup.js)

**Assertion Library:**

- Jest built-in matchers (`expect(val).toBe(...)`, `expect(val).toEqual(...)`, `expect(val).rejects.toThrow(...)`)

**Run Commands:**

```bash
npm run test:unit          # Run all Jest unit tests
npm run test:ocr           # Run dedicated OCR pipeline tests
npm run test:i18n          # Validate Gujarati/English dictionary and keys
npm test                   # Run linting, i18n check, and unit tests
npm run test:watch         # Run tests in interactive watch mode
npm run test:coverage      # Run tests with code coverage reporting
```

## Test File Organization

**Location:**

- Unit tests: [tests/unit/](file:///d:/Health_Vault/health-vault-backend/tests/unit/)
- System/Integration tests: [tests/](file:///d:/Health_Vault/health-vault-backend/tests/)

**Naming:**

- Suffix: `.test.js` (e.g. `documentExtraction.test.js`, `onboardingFlows.test.js`)

**Structure:**

```text
tests/
├── unit/                                  # Pure unit tests (mocked I/O)
│   ├── dateUtils.test.js
│   ├── documentExtraction.test.js
│   ├── documentSweeper.test.js
│   ├── durableQueue.test.js
│   ├── medicationRecurrence.test.js
│   ├── progressiveProgress.test.js
│   └── sseStreamReliability.test.js
├── onboardingFlows.test.js                # Onboarding end-to-end integration flows
├── unifiedChat.test.js                    # Multi-turn chat characterization tests
├── i18nCheck.js                           # Dictionary completeness test runner
└── setup.js                               # Global test setup (mocks env vars)
```

## Test Structure

**Suite Organization:**

```javascript
const documentJobSweeper = require("../../src/jobs/documentJobSweeper");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");

jest.mock("../../src/repositories/documentProcessingJobRepository", () => ({
  sweepExpired: jest.fn(),
  failStalledRunningJobs: jest.fn(),
  findStalledRunningJobs: jest.fn(),
  reconcileRunningJobsOnBoot: jest.fn(),
}));

describe("Document Job Sweeper & Recovery Unit Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    documentJobSweeper.stopSweeper();
  });

  describe("1. Stalled Job Sweeping", () => {
    test("sweepStalledJobs identifies and transitions jobs past cutoff to FAILED", async () => {
      const mockFailed = [
        { id: "job-stalled-1", fileKey: "doc1.pdf", status: "FAILED", retryable: true },
      ];
      documentProcessingJobRepository.failStalledRunningJobs.mockResolvedValue(mockFailed);

      const result = await documentJobSweeper.sweepStalledJobs(15);

      expect(result).toEqual(mockFailed);
      expect(documentProcessingJobRepository.failStalledRunningJobs).toHaveBeenCalledTimes(1);
    });
  });
});
```

**Patterns:**

- `beforeEach`: Reset mocks (`jest.clearAllMocks()`) and reinitialize state.
- `afterEach`: Teardown cron timers, open database handles, or mock spies.
- Strict assertion: Verify both returned payload and call count / arguments of mocked dependencies.

## Mocking

**Framework:**

- Jest native mock functions (`jest.fn()`, `jest.mock()`, `jest.spyOn()`).

**Patterns:**

```javascript
jest.mock("../../src/repositories/patientRepository", () => ({
  findById: jest.fn(),
  update: jest.fn(),
}));
```

**What to Mock:**

- Database repositories (`*Repository.js`) in unit tests.
- External AI services (Ollama, Google GenAI, FastAPI ai-service).
- Cloud storage providers (AWS S3 client, Google Cloud Storage).
- Background schedulers (`node-cron`).
- Firebase Admin token verification.

**What NOT to Mock:**

- Zod validation schemas and parsers (`src/validations/`).
- Pure utility functions (date calculation, JSON cleaners, token helpers).
- Custom exception wrappers (`AppError` hierarchy).
- Domain helpers (`medicineNormalize.helper.js`).

## Fixtures and Factories

**Test Data Pattern:**

- Test datasets and fixtures are kept inline within the test files or in dedicated mock factories:

```javascript
const createMockJob = (overrides = {}) => ({
  id: "job-test-123",
  userId: "user-456",
  fileKey: "prescriptions/test.jpg",
  status: "PENDING",
  stage: "PREPROCESS",
  attempts: 0,
  createdAt: new Date(),
  ...overrides,
});
```

## Coverage

**Requirements:**

- Run `npm run test:coverage` to generate Istanbul HTML and LCOV reports in `coverage/`.

## Test Types

**Unit Tests:**

- Scope: Individual domain services, utility functions, queue state transitions, OCR parser sanitization.
- Fast execution with zero external network or database calls.

**Integration & Characterization Tests:**

- Scope: Multi-turn onboarding state transitions (`tests/onboardingFlows.test.js`), unified chat routing (`tests/unifiedChat.test.js`), and duplicate medication resolution (`tests/medicationDuplicate.test.js`).

**OCR Test Suite:**

- Scope: Dedicated verification of image preprocessing, multi-engine OCR fallback, and structured clinical entity parsing (`npm run test:ocr`).

## Common Patterns

**Async Testing:**

```javascript
test("processes queue item successfully", async () => {
  const result = await queueService.processNextJob();
  expect(result.success).toBe(true);
});
```

**Error Testing:**

```javascript
test("throws NotFoundException when patient does not exist", async () => {
  patientRepository.findById.mockResolvedValue(null);

  await expect(patientService.getProfile("invalid-id")).rejects.toThrow(NotFoundException);
});
```

---

_Testing analysis: 2026-09-22_
