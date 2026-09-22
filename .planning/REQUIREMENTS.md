# Requirements: Health Vault Backend

**Defined:** 2026-09-22
**Milestone:** v1.0 Handle All App-Related User Questions
**Core Value:** Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## v1 Requirements

Requirements for milestone **v1.0: Handle All App-Related User Questions**.

### Medication Occurrences vs. General Medications (OCCUR)

- [ ] **OCCUR-01**: System cleanly differentiates general medication queries (medication list, dosage, frequency) from medication occurrence queries (today's status, missed, taken, pending, next dose, overdue).
- [ ] **OCCUR-02**: Questions regarding missed doses ("Did I miss any medicine today?", "Did I skip a dose today?") retrieve today's actual `missed` occurrences for the authenticated user, never returning the generic medication list.
- [ ] **OCCUR-03**: Questions regarding taken, pending, or next upcoming doses ("Which medicines did I take today?", "Which medicines are still pending?", "When is my next medicine?") retrieve today's `taken`, `pending`, or next upcoming dose records from the authenticated user's occurrence data.
- [ ] **OCCUR-04**: Occurrence retrieval reuses the existing medication occurrence calculation logic (`todayOccurrences`, `taken`, `missed`, `pending`) as the authoritative source of truth.

### Domain & Intent Classification (INTENT)

- [ ] **INTENT-01**: Intent detection engine classifies queries into both structured domains and specific intents (`MEDICATION_LIST`, `MEDICATION_DETAILS`, `MEDICATION_SCHEDULE`, `NEXT_MEDICATION`, `MISSED_MEDICATION`, `TAKEN_MEDICATION`, `PENDING_MEDICATION`, `MEDICATION_STATUS_TODAY`, `MEDICATION_REFILL`, `PROFILE_QUERY`, `DOCUMENT_QUERY`, `NOTIFICATION_QUERY`).
- [ ] **INTENT-02**: System accurately handles User Profile and Medical Profile questions ("What is my age?", "What information is stored in my profile?", blood group, allergies).
- [ ] **INTENT-03**: System accurately handles Notification queries ("What notifications do I have?", "How many unread notifications do I have?").
- [ ] **INTENT-04**: Intent detection supports natural language phrasing, variations, and synonyms without relying exclusively on exact keyword matches.

### Multi-Domain Queries (MULTI)

- [ ] **MULTI-01**: Classifier detects composite queries requiring multiple application domains (e.g. Document + Medication, Refill + Medication Occurrence) and returns an additive set of domains and intents.
- [ ] **MULTI-02**: Context builder aggregates minimal, relevant context from each matched domain into the AI prompt without loading unneeded domains.

### Multilingual Support (I18N)

- [ ] **I18N-01**: Intent and domain detection functions equivalently across English, Hindi, Gujarati, Marathi, and Tamil without duplicated per-language business logic.
- [ ] **I18N-02**: Non-English queries are normalized/translated early for intent routing and clinical reasoning while preserving the user's raw input.
- [ ] **I18N-03**: Final answers are delivered in the user's detected or preferred response language via the existing language conversion flow.

### Fact Grounding & Data Scoping (GROUND)

- [ ] **GROUND-01**: All database queries and context generation strictly scope to the authenticated patient's `userId`.
- [ ] **GROUND-02**: System instructions enforce zero-hallucination; when requested data does not exist (e.g., zero missed medicines, no notifications, no uploaded reports), the system explicitly states that no records exist rather than generating an assumed answer.
- [ ] **GROUND-03**: Minimal context selection rule is enforced so the LLM prompt contains only the data necessary to answer the detected intent(s).

### Pipeline Observability & Debugging (DEBUG)

- [ ] **DEBUG-01**: System provides comprehensive end-to-end trace logging for the chatbot pipeline (Question → Language → Domain → Intent → Context Selection → DB Query → Retrieved Occurrences/Meds → Prompt → AI Response → Localized Reply).
- [ ] **DEBUG-02**: Trace and verify specifically the failing query "Did I miss any medicine today?", validating every stage through to correct missed-occurrence answering.

### Testing & Verification (TEST)

- [ ] **TEST-01**: Unit tests verify occurrence-specific intents (`MISSED_MEDICATION`, `TAKEN_MEDICATION`, `PENDING_MEDICATION`, `NEXT_MEDICATION`, `MEDICATION_STATUS_TODAY`) and ensure they do not fall back to generic medication lists.
- [ ] **TEST-02**: Unit tests verify single-domain questions across all domains (Profile, Medical Profile, Documents, Medications, Schedules, Reminders, Occurrences, Notifications, Refills).
- [ ] **TEST-03**: Unit tests verify equivalent queries across all 5 languages (English, Hindi, Gujarati, Marathi, Tamil).
- [ ] **TEST-04**: Unit tests verify multi-domain queries (e.g. Report + Medications, Refills + Occurrences).
- [ ] **TEST-05**: Automated regression suite confirms zero breaking changes to existing Document RAG, document Q&A, OCR summaries, and onboarding flows (`npm run test:unit`).

## Out of Scope

| Feature                                          | Reason                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| Separate standalone chatbot microservice         | Must extend existing Express `chat.service.js` and `ragContext.service.js`. |
| Modifying onboarding state machine transitions   | Onboarding state engine is strictly decoupled from chat.                    |
| Altering medication cron recurrence calculations | Cron jobs already manage occurrences; chat only queries them.               |
| Chat-based database mutations                    | Read-only conversational assistance for this milestone.                     |

## Traceability

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| OCCUR-01    | Phase 2 | Pending |
| OCCUR-02    | Phase 2 | Pending |
| OCCUR-03    | Phase 2 | Pending |
| OCCUR-04    | Phase 2 | Pending |
| INTENT-01   | Phase 2 | Pending |
| INTENT-02   | Phase 3 | Pending |
| INTENT-03   | Phase 3 | Pending |
| INTENT-04   | Phase 2 | Pending |
| MULTI-01    | Phase 2 | Pending |
| MULTI-02    | Phase 3 | Pending |
| I18N-01     | Phase 1 | Pending |
| I18N-02     | Phase 1 | Pending |
| I18N-03     | Phase 1 | Pending |
| GROUND-01   | Phase 4 | Pending |
| GROUND-02   | Phase 4 | Pending |
| GROUND-03   | Phase 4 | Pending |
| DEBUG-01    | Phase 1 | Pending |
| DEBUG-02    | Phase 1 | Pending |
| TEST-01     | Phase 5 | Pending |
| TEST-02     | Phase 5 | Pending |
| TEST-03     | Phase 5 | Pending |
| TEST-04     | Phase 5 | Pending |
| TEST-05     | Phase 5 | Pending |

**Coverage:**

- v1 requirements: 23 total
- Mapped to phases: 23
- Unmapped: 0 ✓

---

_Requirements defined: 2026-09-22_
_Last updated: 2026-09-22_
