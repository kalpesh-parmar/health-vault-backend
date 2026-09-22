# Health Vault Backend

## What This Is

Health Vault is a secure, AI-powered healthcare portal backend designed to manage patient medical records, extract structured clinical data from uploaded documents, orchestrate medication adherence schedules, and facilitate contextual RAG (Retrieval-Augmented Generation) health chats. Built on Express.js and PostgreSQL with pgvector, it supports multi-device sessions, FCM push notifications, and multilingual interactions in English, Hindi, Gujarati, Marathi, and Tamil.

## Core Value

Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## Current Milestone: v1.0 Handle All App-Related User Questions

**Goal:** Improve the current chatbot/general-question flow so that it reliably understands and answers user questions across all core application areas (User Profile, Medical Profile, Documents/Reports, Medications, Schedules, Reminders, Occurrences, Notifications, Refills) in English, Hindi, Gujarati, Marathi, and Tamil using verified user context.

**Target features:**

- **Medication Occurrence vs. Medication Distinction**: Accurately differentiate general medication questions ("What medicines do I take?") from occurrence/reminder questions ("Did I miss any medicine today?", "Which medicines did I take today?", "When is my next medicine?"), querying actual today's dosage occurrences (`missed`, `taken`, `pending`, `upcoming`) rather than falling back to the generic medication list.
- **Robust Domain & Intent Classification**: Implement an additive multi-domain, multi-intent classification engine that supports natural phrasing and variations beyond rigid keyword matching across English, Hindi, Gujarati, Marathi, and Tamil.
- **Comprehensive Omni-Domain Coverage**: Deep context retrieval for User Profile (age, DOB, blood group, allergies), Documents (uploaded reports, lab values, doctor names), Medications (dosage, frequency), Occurrences (taken, missed, pending, next dose, overdue), Notifications (unread count, recent alerts), and Refills (pill counts, low-stock warnings).
- **Multi-Domain Context Synthesis**: Detect composite questions that span multiple domains (e.g. "Based on my latest report, which medicines am I currently taking?", "Which medicines need a refill and when is my next dose?") and assemble minimal, relevant multi-context prompts.
- **Strict Data Grounding & Anti-Hallucination**: Query strictly against authenticated `userId` and explicitly inform users in their preferred language when records do not exist, never hallucinating assumptions or unverified clinical data.
- **Multilingual Equivalence & Seamless I18N**: Uniform intent and domain handling across English, Hindi, Gujarati, Marathi, and Tamil without duplicated business logic, preserving the application's existing preferred-language response delivery.
- **Zero Regressions & Traceability**: Preserve existing Document RAG semantic retrieval, document summaries, OCR pipelines, and cron jobs. Ensure end-to-end debugging observability from question input to final localized output.

## Requirements

### Validated

- ✓ Mobile OTP authentication and JWT session management — v1.0
- ✓ Multi-stage asynchronous document processing pipeline with SSE real-time updates — v1.0
- ✓ Resilient background job queue with heartbeat monitoring and boot recovery — v1.0
- ✓ Deterministic bilingual patient onboarding state machine — v1.0
- ✓ Medication adherence scheduling and cron-based dosage alerts — v1.0
- ✓ Document RAG semantic search using PostgreSQL pgvector — v1.0

### Active

- [ ] **DEBUG-TRACE**: Trace and log end-to-end the failing "Did I miss any medicine today?" flow through language, domain, intent, context, database query, prompt, LLM response, and translation.
- [ ] **I18N-DETECT**: Detect input language and normalize natural query phrasing across English, Hindi, Gujarati, Marathi, and Tamil.
- [ ] **INTENT-DETECT**: Implement domain and intent classification supporting single and multi-intent queries (`MEDICATION_LIST`, `MISSED_MEDICATION`, `TAKEN_MEDICATION`, `PENDING_MEDICATION`, `NEXT_MEDICATION`, `MEDICATION_REFILL`, `PROFILE_QUERY`, `DOCUMENT_QUERY`, `NOTIFICATION_QUERY`).
- [ ] **OCCURRENCE-CTX**: Query and inject today's actual medication occurrences (`missed`, `taken`, `pending`, `next_dose`, `overdue`) from the database, resolving the missed medicine bug.
- [ ] **OMNI-CTX**: Retrieve targeted context for User Profile, Medical Profile, Documents/Reports, Medications, Notifications, and Refills.
- [ ] **MULTI-CTX**: Assemble composite contexts when user queries bridge multiple domains (e.g. Report + Medications, Refill + Occurrences).
- [ ] **DATA-GROUNDING**: Enforce strict authenticated user data scoping and zero-hallucination responses when data is missing.
- [ ] **I18N-REPLY**: Deliver responses in the user's preferred or detected language with high quality.
- [ ] **REGRESSION-PARITY**: Ensure existing Document RAG Q&A, document summarization, and OCR flows remain unaffected.
- [ ] **TEST-MATRIX**: Comprehensive automated test suite verifying occurrence status, all 7 domains, multi-domain queries, 5 languages, missing data scenarios, and regression tests.

### Out of Scope

- Creating a parallel, completely separate chatbot service outside Express (must extend existing `chat.service.js` and `ragContext.service.js`).
- Modifying deterministic patient onboarding state machine transitions (`onboardingStateMachine.js`).
- Altering core medication recurrence cron calculations in `src/jobs/medicationCron.js`.
- Chat-based mutations or direct actions (e.g. marking a medicine taken via chat).

## Context

- The application has an existing chatbot in `src/services/ai/chat/chat.service.js` and `src/services/ai/chat/ragContext.service.js`.
- Currently, when users ask occurrence questions like "Did I miss any medicine today?", the system misclassifies or falls back to a generic medication list inquiry because it lacks granular intent detection and occurrence-specific context generation.
- Queries phrased naturally or in Indian vernaculars (Hindi, Gujarati, Marathi, Tamil) struggle against rigid keyword matching in `keywordDictionary.js`.

## Constraints

- **Language & Runtime**: Node.js CommonJS JavaScript (`require` / `module.exports`) only — strictly NO TypeScript.
- **Architecture**: Decoupled clean architecture (Route → Validation → Controller → Service → Repository → Model).
- **Messaging**: All messages must come from `src/constants/` (`messageConstants.js`, `errorConstants.js`, `chatReplies.js`).
- **Data Privacy**: Queries and context assembly must strictly scope to `req.auth.userId`.
- **Supported Languages**: English (`en`), Hindi (`hi`), Gujarati (`gu`), Marathi (`mr`), Tamil (`ta`).

## Key Decisions

| Decision                                              | Rationale                                                                                                      | Outcome   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| Differentiate `medication` vs `medication_occurrence` | General medication info (schedule, dose, list) is distinct from today's intake status (missed, taken, pending) | — Pending |
| Multi-intent domain set resolution                    | Questions can span multiple domains simultaneously, requiring composite context injection                      | — Pending |
| Multilingual semantic intent matching                 | Indian vernacular queries (hi, gu, mr, ta) must reliably resolve without duplicating business logic            | — Pending |
| Reuse existing occurrence calculation logic           | Use the existing source of truth for dosage occurrences (`todayOccurrences`, `taken`, `missed`, `pending`)     | — Pending |

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

_Last updated: 2026-09-22 after milestone v1.0 initialization_
