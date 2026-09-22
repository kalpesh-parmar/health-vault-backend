# Requirements: Health Vault Backend

**Defined:** 2026-09-22
**Core Value:** Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## v1 Requirements

Requirements for milestone **v1.0: Handle All App-Related User Questions (Omni-Domain Multilingual Chatbot)**.

### Pipeline & Multilingual Normalization (I18N)

- [ ] **I18N-01**: User query language is detected using ML language detection supporting English, Hindi, Gujarati, Marathi, and Tamil.
- [ ] **I18N-02**: Non-English queries are translated to English early in the pipeline (`englishQuestion`), enabling robust semantic classification and vector search while preserving raw input for user display.
- [ ] **I18N-03**: Final chatbot answers are localized and delivered in the user's detected or preferred language across all 5 supported languages.

### Omni-Domain Intent & Routing (ROUTING)

- [ ] **ROUTING-01**: Intent classifier resolves queries into an additive domain set (`PROFILE`, `DOCUMENTS`, `MEDICATIONS`, `REMINDERS`, `OCCURRENCES`, `REFILLS`, `NOTIFICATIONS`) rather than mutually-exclusive single choices.
- [ ] **ROUTING-02**: Eliminate artificial domain suppression (e.g. `!hasDocReference` suppressing medication/reminder checks), enabling multi-domain intent detection.
- [ ] **ROUTING-03**: Intent detection matches natural language phrasing, synonyms, and variations without requiring exact string equality.

### Domain Context Assembly (CONTEXT)

- [ ] **CTX-01**: System retrieves and injects complete patient profile information (name, DOB, age, blood group, allergies, patient code, login type) when profile intent is detected.
- [ ] **CTX-02**: System retrieves active medications, dosages, frequencies, food instructions, and ongoing schedules when medication intent is detected.
- [ ] **CTX-03**: System retrieves today's dosage occurrences (taken, missed, pending, overdue) and upcoming reminder times when reminder/occurrence intent is detected.
- [ ] **CTX-04**: System retrieves remaining pill stock, refill dates, and low-stock warnings when refill intent is detected.
- [ ] **CTX-05**: System retrieves recent medical reports, diagnoses, lab test results, and doctor names when document intent is detected.
- [ ] **CTX-06**: System retrieves unread alerts and system notifications when notification intent is detected.
- [ ] **CTX-07**: When queries span multiple domains, system aggregates all matching domain contexts into a single comprehensive prompt.

### Fact Grounding & Anti-Hallucination (GROUNDING)

- [ ] **GROUND-01**: Answers are generated strictly using authenticated user database records without hallucinating missing medications, reports, or profile data.
- [ ] **GROUND-02**: When a user queries a domain with zero database records (e.g. no active medications or no uploaded reports), the system clearly informs the user in their language that no records exist.
- [ ] **GROUND-03**: Existing single-document RAG question-answering and summary flows remain fully functional without regressions.

### Testing & Verification (TEST)

- [ ] **TEST-01**: Automated unit tests verify domain detection across English, Hindi, Gujarati, Marathi, and Tamil queries.
- [ ] **TEST-02**: Automated unit tests verify multi-domain queries combining Documents + Medications, Medications + Refills + Reminders, and Profile + Allergies.
- [ ] **TEST-03**: Automated unit tests verify proper handling when user data is missing (0 medications, 0 reports, empty profile fields).
- [ ] **TEST-04**: Full regression suite passes (`npm run test:unit`) ensuring zero degradation to existing document RAG, summaries, or crons.

## v2 Requirements

Deferred to future releases:

### Advanced Clinical Conversational Features

- **VOICE-01**: Direct voice-to-voice multilingual consultation using Whisper and TTS endpoints.
- **ACTION-01**: Conversational mutation execution (e.g. "Mark my morning Metformin as taken" via chat).

## Out of Scope

| Feature                                                                 | Reason                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Building a parallel standalone chatbot microservice                     | Must extend and refine existing Express `chat.service.js` and `ragContext.service.js`. |
| Modifying deterministic onboarding step transitions                     | Onboarding state machine is strictly decoupled from general chat.                      |
| Altering medication recurrence cron calculations in `medicationCron.js` | Cron scheduling is working; chat only reads occurrences and schedules.                 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| I18N-01     | Phase 1 | Pending |
| I18N-02     | Phase 1 | Pending |
| I18N-03     | Phase 1 | Pending |
| ROUTING-01  | Phase 2 | Pending |
| ROUTING-02  | Phase 2 | Pending |
| ROUTING-03  | Phase 2 | Pending |
| CTX-01      | Phase 3 | Pending |
| CTX-02      | Phase 3 | Pending |
| CTX-03      | Phase 3 | Pending |
| CTX-04      | Phase 3 | Pending |
| CTX-05      | Phase 3 | Pending |
| CTX-06      | Phase 3 | Pending |
| CTX-07      | Phase 3 | Pending |
| GROUND-01   | Phase 4 | Pending |
| GROUND-02   | Phase 4 | Pending |
| GROUND-03   | Phase 4 | Pending |
| TEST-01     | Phase 5 | Pending |
| TEST-02     | Phase 5 | Pending |
| TEST-03     | Phase 5 | Pending |
| TEST-04     | Phase 5 | Pending |

**Coverage:**

- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0 ✓

---

_Requirements defined: 2026-09-22_
_Last updated: 2026-09-22 after initial definition_
