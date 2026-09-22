---
phase: 1
phase_slug: chatbot-pipeline-characterization-multilingual-gateway-debug
date: 2026-09-22
status: defined
---

# Phase 1: Validation Strategy

## 1. Validation Architecture

This validation strategy governs Phase 1: Chatbot Pipeline Characterization, Multilingual Gateway & Debug Tracing.

### Test Matrix

| Requirement  | Target Component                           | Test File                                | Verification Criteria                                                             |
| ------------ | ------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------- |
| **I18N-01**  | `chat.service.js:_resolveLanguage`         | `tests/unit/chatPipelineTracing.test.js` | Accurately identifies `en`, `hi`, `gu`, `mr`, `ta` from user input.               |
| **I18N-02**  | `chat.service.js:_resolveQuestion`         | `tests/unit/chatPipelineTracing.test.js` | Populates `ctx.englishQuestion` for non-English queries via `aiClient.translate`. |
| **I18N-03**  | `chat.service.js:_saveAndReturn`           | `tests/unit/chatPipelineTracing.test.js` | Preserves detected user language for final response delivery.                     |
| **DEBUG-01** | `chat.service.js:sendMessage`              | `tests/unit/chatPipelineTracing.test.js` | Logs structured trace across all 10 pipeline steps.                               |
| **DEBUG-02** | `chat.service.js:_handleReminderIntercept` | `tests/unit/chatPipelineTracing.test.js` | Traces and isolates the missed medicine bug with full record logging.             |

### Commands

```bash
# Run Phase 1 unit test
npm test -- tests/unit/chatPipelineTracing.test.js

# Run complete unit test suite
npm run test:unit
```

## 2. Nyquist Compliance Check

- [x] Automated unit test suite verifying translation gateway.
- [x] Trace assertions confirming logging of question, language, domain, intent, DB queries, and prompt.
- [x] Regression testing: existing tests pass with 0 failures.
