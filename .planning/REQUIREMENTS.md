# Requirements: Health Vault Backend

**Defined:** 2026-09-24
**Verified:** 2026-09-25
**Milestone:** v1.1 Precise Omni-Domain Answers, Occurrence Accuracy & 60-Question Multilingual Validation
**Core Value:** Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## v1.1 Requirements

### Medication Queries & Stored End Dates (MED)

- [x] **MED-01**: System uses stored endDate directly from the medications table in all context assembly and replies, never recalculating or returning mismatched end dates.
- [x] **MED-02**: System reliably answers all 14 core medication questions (medicines taking, list medications, all medicines, current medication, morning medicine, night medicine, medicine count, dosage, when to take, active medications, inactive medications, medicine dose, before-food medicines, after-food medicines).

### Medication Reminders & Occurrence Logic (OCCUR)

- [x] **OCCUR-01**: Occurrence status logic: if a dose is marked taken, it is never counted as missed.
- [x] **OCCUR-02**: Overdue doses: if an occurrence is overdue and not marked taken, it is counted as missed.
- [x] **OCCUR-03**: Occurrence counters provide exact, accurate counts for taken, pending, and missed doses.
- [x] **OCCUR-04**: Specific intent queries return exact targeted answers: missed medicine questions return only missed items; next reminder questions return only the next upcoming reminder; queries for reminder at a specific time (e.g. 9 AM) return only matching reminders.
- [x] **OCCUR-05**: System reliably answers all 10 core reminder questions (medication reminders, medicine reminders, today's reminders, need to take today, reminders tomorrow, did I miss any today, overdue reminders, missed reminders, next reminder, reminder at 9 AM).

### Refill Grounding & Real Data (REFILL)

- [x] **REFILL-01**: System eliminates fallback placeholders like "Refills Remaining - N/A", querying actual refill records and displaying true refill quantities or stating clearly when no refills are recorded.
- [x] **REFILL-02**: System reliably answers all 10 core refill questions (show refills, list refills, which need refill, pending refills, latest refill, refill count, recently refilled, refill history, last refill date, do I need to refill).

### Document Citations & Page Meta Removal (DOC)

- [x] **DOC-01**: System returns exact, verified names of medical reports and documents matching authenticated user uploads.
- [x] **DOC-02**: System strips all internal prompt metadata and artifact noise (e.g. (the current page is 1 of 1) and raw chunk formatting) from final chatbot replies.
- [x] **DOC-03**: System reliably answers all 10 core document questions (show medical documents, list documents, what medical reports, latest report, document count, most recent report, blood test report, laboratory reports, uploaded reports, list medical reports).

### Profile & Notifications (PROF_NOTIF)

- [x] **PROF-01**: System reliably answers all 10 profile questions (name, age, date of birth, gender, blood group, show profile, personal information, stored information, phone number, email address).
- [x] **NOTIF-01**: System reliably answers all 10 notification questions (show notifications, what notifications, list notifications, unread notifications, latest notifications, last notification, today's notifications, unread count, important notifications, recent notifications).

### Multilingual Equivalence, Style & Regression Safety (I18N_STYLE)

- [x] **I18N-01**: Natural language understanding and response generation function uniformly across English, Gujarati, Hindi, Marathi, and Tamil without duplicated business logic.
- [x] **STYLE-01**: Chatbot responses adhere to a strictly concise and direct format (clean bullet points, no boilerplate greetings, zero meta/debug leakage).
- [x] **FLOW-01**: Full regression parity: existing patient onboarding state machine, OCR extraction pipelines, and document RAG Q&A flows remain intact without modification.

### 60-Question Automated Validation Suite (TEST)

- [x] **TEST-01**: Automated test matrix validates all 10 Profile questions with assertions on exact field matching.
- [x] **TEST-02**: Automated test matrix validates all 14 Medication questions with assertions on stored endDate and timing filters.
- [x] **TEST-03**: Automated test matrix validates all 10 Reminder/Occurrence questions with assertions on taken/missed/overdue counts and targeted replies.
- [x] **TEST-04**: Automated test matrix validates all 10 Notification questions with assertions on unread counts and sorting.
- [x] **TEST-05**: Automated test matrix validates all 10 Refill questions with assertions on real refill data and absence of N/A.
- [x] **TEST-06**: Automated test matrix validates all 10 Document questions with assertions on document names and removal of (the current page is 1 of 1).
- [x] **TEST-07**: Automated multilingual test assertions verify answers in English, Gujarati, Hindi, Marathi, and Tamil, with 100% pass rate in npm run test:unit.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Modifying onboarding state machine transitions | Onboarding state engine is strictly decoupled from general chat. |
| Altering core medication cron recurrence calculations | Cron jobs already manage recurrence cycles; chat queries existing records. |
| Chat-based database mutations | Read-only conversational assistance for this milestone. |

## Traceability

| Requirement | Phase | Status |
| --- | --- | --- |
| MED-01 | Phase 1 | Complete |
| MED-02 | Phase 1 | Complete |
| OCCUR-01 | Phase 2 | Complete |
| OCCUR-02 | Phase 2 | Complete |
| OCCUR-03 | Phase 2 | Complete |
| OCCUR-04 | Phase 2 | Complete |
| OCCUR-05 | Phase 2 | Complete |
| REFILL-01 | Phase 3 | Complete |
| REFILL-02 | Phase 3 | Complete |
| DOC-01 | Phase 3 | Complete |
| DOC-02 | Phase 3 | Complete |
| DOC-03 | Phase 3 | Complete |
| PROF-01 | Phase 4 | Complete |
| NOTIF-01 | Phase 4 | Complete |
| I18N-01 | Phase 4 | Complete |
| STYLE-01 | Phase 4 | Complete |
| FLOW-01 | Phase 4 | Complete |
| TEST-01 | Phase 5 | Complete |
| TEST-02 | Phase 5 | Complete |
| TEST-03 | Phase 5 | Complete |
| TEST-04 | Phase 5 | Complete |
| TEST-05 | Phase 5 | Complete |
| TEST-06 | Phase 5 | Complete |
| TEST-07 | Phase 5 | Complete |

**Coverage:**
- Total requirements: 24
- Completed: 24
- Remaining: 0

---

_Requirements defined: 2026-09-24 - Verified: 2026-09-25_
