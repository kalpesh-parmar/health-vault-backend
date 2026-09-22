---
phase: 1
slug: 01-chatbot-pipeline-audit-multilingual-translation-gateway
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-09-22
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| **Framework**          | Jest 29.x (Node.js)                                   |
| **Config file**        | package.json / jest configuration                     |
| **Quick run command**  | `npm test -- tests/unit/chatCharacterization.test.js` |
| **Full suite command** | `npm run test:unit`                                   |
| **Estimated runtime**  | ~15 seconds                                           |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- tests/unit/chatCharacterization.test.js`
- **After every plan wave:** Run `npm run test:unit`
- **Before `/gsd-verify-work`:** Target suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement      | Threat Ref | Secure Behavior                                                 | Test Type | Automated Command                                            | File Exists | Status     |
| -------- | ---- | ---- | ---------------- | ---------- | --------------------------------------------------------------- | --------- | ------------------------------------------------------------ | ----------- | ---------- |
| 01-01-01 | 01   | 1    | I18N-01          | —          | N/A                                                             | unit      | `npm test -- tests/unit/dateUtils.test.js`                   | ✅          | ⬜ pending |
| 01-01-02 | 01   | 1    | I18N-02          | —          | Sanitize & prevent prompt injection during translation fallback | unit      | `npm test -- tests/unit/chatCharacterization.test.js`        | ✅          | ⬜ pending |
| 01-02-01 | 02   | 2    | I18N-03          | —          | N/A                                                             | unit      | `npm test -- tests/unit/keywordRefactorVerification.test.js` | ✅          | ⬜ pending |
| 01-02-02 | 02   | 2    | I18N-01, I18N-03 | —          | N/A                                                             | unit      | `npm test -- tests/unit/chatCharacterization.test.js`        | ✅          | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `tests/unit/chatTranslationGateway.test.js` — Unit tests for early query translation, language normalization, and fallback handling
- [ ] `tests/unit/keywordDictionaryExpansion.test.js` — Multi-language verification tests for `keywordDictionary.js`

---

## Manual-Only Verifications

| Behavior                            | Requirement | Why Manual                                   | Test Instructions                                                                        |
| ----------------------------------- | ----------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| IndicTrans2 live container response | I18N-02     | Requires running Python AI service container | Post query via `/chat/message` with Hindi text, verify log shows IndicTrans2 translation |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 25s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending 2026-09-22
