# Health Vault Backend

## What This Is

Health Vault is a secure, AI-powered healthcare portal backend designed to manage patient medical records, extract structured clinical data from uploaded documents, orchestrate medication adherence schedules, and facilitate contextual RAG (Retrieval-Augmented Generation) health chats. Built on Express.js and PostgreSQL with pgvector, it supports multi-device sessions, FCM push notifications, and multilingual interactions in English, Hindi, Gujarati, Marathi, and Tamil.

## Core Value

Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## Current Milestone: v1.1 Precise Omni-Domain Answers, Occurrence Accuracy & 60-Question Multilingual Validation

**Goal:** Resolve context inaccuracies, occurrence calculations, and noisy prompt metadata to deliver strictly concise, exact answers across Profile, Medications, Reminders, Notifications, Refills, and Documents in English, Gujarati, Hindi, Marathi, and Tamil, validated by a comprehensive 60-question test matrix without breaking existing application flows.

**Target features:**

- **End Date & Stored Calculation**: Use stored end dates from the medications table directly in context/replies rather than flawed dynamic calculations.
- **Accurate Intake & Status Counts**: If a dose was taken, do NOT count it as missed. Overdue doses that are not taken count as missed. Provide exact taken/pending/missed counts.
- **Targeted & Exact Intent Responses**: When asked about missed medicines, return only missed; when asked for the next reminder, return only the next upcoming reminder; avoid unrelated dumps.
- **Refill Tracking & Proper Data Grounding**: Eliminate "Refills Remaining - N/A"; query actual refill records and display correct refill quantities/history according to user queries.
- **Clean Document Citations & Page Meta Removal**: Return exact document/report names and strip out internal artifact text (e.g., "(the current page is 1 of 1)").
- **Multilingual Consistency (5 Languages)**: Ensure exact, concise answers work reliably in English, Gujarati, Hindi, Marathi, and Tamil.
- **Flow Preservation**: Preserve existing onboarding state machines, OCR pipelines, and document RAG flows without regressions.
- **60-Question Omni-Domain Validation Suite**: Automated test coverage validating all 60 specific questions across Profile (10), Medications (14), Reminders/Occurrences (10), Notifications (10), Refills (10), and Documents (10).

## Requirements

### Validated

- ✓ Mobile OTP authentication and JWT session management — v1.0
- ✓ Multi-stage asynchronous document processing pipeline with SSE real-time updates — v1.0
- ✓ Resilient background job queue with heartbeat monitoring and boot recovery — v1.0
- ✓ Deterministic bilingual patient onboarding state machine — v1.0
- ✓ Medication adherence scheduling and cron-based dosage alerts — v1.0
- ✓ Document RAG semantic search using PostgreSQL pgvector — v1.0

### Active

- [ ] **MED-ENDDATE**: Use stored `endDate` from the medications table directly in context and replies rather than flawed dynamic end date calculations.
- [ ] **OCCUR-STATUS**: Differentiate taken vs missed vs pending vs overdue: doses marked `taken` are excluded from missed; overdue un-taken doses are counted as missed. Return accurate counts for each.
- [ ] **INTENT-TARGET**: When user asks specific questions (e.g. missed medications, next reminder, refill status), provide targeted answers without dumping unrelated lists or generic responses.
- [ ] **REFILL-DATA**: Resolve refills using the database/table directly, eliminating "Refills Remaining - N/A", and reporting actual refill quantities/history.
- [ ] **DOC-CLEAN**: Provide accurate document/report names and strip internal artifact text (e.g., `(the current page is 1 of 1)` and system prompt noise).
- [ ] **I18N-5LANG**: Ensure accurate understanding and concise reply delivery across English, Gujarati, Hindi, Marathi, and Tamil.
- [ ] **FLOW-PARITY**: Zero regressions in onboarding state machines, OCR processing, and document RAG pipelines.
- [ ] **TEST-60MATRIX**: Implement automated testing covering all 60 specific test questions across Profile, Medications, Reminders/Occurrences, Notifications, Refills, and Documents in the 5 languages.

### Out of Scope

- Modifying deterministic patient onboarding state machine transitions (`onboardingStateMachine.js`).
- Altering core medication recurrence cron calculations in `src/jobs/medicationCron.js`.
- Chat-based database mutations or direct actions (e.g. marking a medicine taken via chat).

## Context

- The application has an existing chatbot in `src/services/ai/chat/chat.service.js` and `src/services/ai/chat/ragContext.service.js`.
- Users test specific questions across Profile, Medications, Reminders, Notifications, Refills, and Documents in 5 languages (English, Hindi, Gujarati, Marathi, Tamil).
- Known defects to fix: dynamic end date calculation errors, incorrect status logic between taken and missed/overdue, "Refills Remaining - N/A" fallback placeholders, document citations showing internal page number metadata like `(the current page is 1 of 1)`.

## Constraints

- **Language & Runtime**: Node.js CommonJS JavaScript (`require` / `module.exports`) only — strictly NO TypeScript.
- **Architecture**: Decoupled clean architecture (Route → Validation → Controller → Service → Repository → Model).
- **Messaging**: All messages must come from `src/constants/` (`messageConstants.js`, `errorConstants.js`, `chatReplies.js`).
- **Data Privacy**: Queries and context assembly must strictly scope to `req.auth.userId`.
- **Supported Languages**: English (`en`), Hindi (`hi`), Gujarati (`gu`), Marathi (`mr`), Tamil (`ta`).

## Key Decisions

| Decision | Rationale | Outcome |
| -------- | --------- | ------- |
| Stored `endDate` on medication | Use DB stored end date directly rather than recalculating | — Pending |
| Overdue non-taken is missed | Any past dosage occurrence not marked `taken` is counted as `missed` | — Pending |
| Precise targeted extraction | Strip unrelated domain context when query is specific (e.g. next reminder only) | — Pending |
| Document artifact sanitization | Filter out system metadata like `(the current page is 1 of 1)` before response formatting | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

_Last updated: 2026-09-24 after milestone v1.1 initialization_
