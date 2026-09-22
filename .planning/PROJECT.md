# Health Vault Backend

## What This Is

Health Vault is a secure, AI-powered healthcare portal backend designed to manage patient medical records, extract structured clinical data from uploaded documents, orchestrate medication adherence schedules, and facilitate contextual RAG (Retrieval-Augmented Generation) health chats. Built on Express.js and PostgreSQL with pgvector, it supports multi-device sessions, FCM push notifications, and multilingual interactions in English, Hindi, Gujarati, Marathi, and Tamil.

## Core Value

Reliable, compliant, and accurate clinical data extraction, semantic search retrieval, and medication tracking for patient healthcare management.

## Current Milestone: v1.0 Handle All App-Related User Questions (Omni-Domain Multilingual Chatbot)

**Goal:** Enable the chatbot to reliably understand and answer single- and multi-domain user questions across all core application areas (Profile, Documents, Medications, Schedules, Reminders, Occurrences, Refills, Notifications) in English, Hindi, Gujarati, Marathi, and Tamil using real user context.

**Target features:**

- Comprehensive audit and characterization of existing chatbot pipeline (`chat.service.js`, `ragContext.service.js`, `translation`, and keyword dictionaries)
- Robust intent/domain detection supporting natural phrasing, language variations, and multi-domain queries without relying solely on rigid English keyword matching
- Multi-domain context assembly joining Profile, Documents, Medications, Reminder Occurrences, Refills, and Notifications
- Fact-grounded response generation strictly based on authenticated user data (no hallucinated medications or records)
- Zero regressions on existing Document RAG, summarization, and preferred-language translation flows
- Automated test coverage across all 5 languages, single/multi-domain prompts, missing-data fallbacks, and keyword-less queries

## Requirements

### Validated

- ✓ Mobile OTP authentication and JWT session management — v1.0
- ✓ Multi-stage asynchronous document processing pipeline with SSE real-time updates — v1.0
- ✓ Resilient background job queue with heartbeat monitoring and boot recovery — v1.0
- ✓ Deterministic bilingual patient onboarding state machine — v1.0
- ✓ Medication adherence scheduling and cron-based dosage alerts — v1.0
- ✓ Document RAG semantic search using PostgreSQL pgvector — v1.0

### Active

- [ ] **CHAT-AUDIT**: Trace and document the 10-step chatbot pipeline flow identifying all failure modes in domain routing and multilingual translation
- [ ] **DOMAIN-DETECT**: Implement resilient multi-domain intent detection supporting English, Hindi, Gujarati, Marathi, and Tamil with semantic tolerance beyond rigid keyword dictionaries
- [ ] **CTX-PROFILE**: Retrieve and inject complete patient profile and clinical baseline data into chat context
- [ ] **CTX-MEDS**: Retrieve active prescriptions, schedules, refill status, and dosage timings into chat context
- [ ] **CTX-OCCURRENCE**: Retrieve upcoming, pending, missed, and taken medication occurrences into chat context
- [ ] **CTX-DOCS**: Preserve and seamlessly link medical report summaries, lab values, and diagnoses with general chat queries
- [ ] **CTX-NOTIF**: Retrieve unread/recent patient notifications and reminder alerts into chat context
- [ ] **MULTI-DOMAIN**: Orchestrate multi-context prompts when a question spans multiple domains (e.g. latest report + active medications, or refills + upcoming doses)
- [ ] **NO-HALLUCINATE**: Guarantee responses state data is unavailable when a user has no records for a queried domain rather than hallucinating
- [ ] **I18N-FLOW**: Seamlessly handle input question translation, English clinical reasoning, and translation back to preferred user language across all 5 languages
- [ ] **TEST-MATRIX**: Comprehensive test suite covering all domains, multi-domain queries, 5 languages, missing records, and regression protection for document RAG

### Out of Scope

- Creating a parallel, completely separate chatbot service outside Express (must extend existing `chat.service.js` and `ragContext.service.js`)
- Modifying deterministic patient onboarding state machine transitions (`onboardingStateMachine.js`)
- Altering core medication recurrence cron calculations in `src/jobs/medicationCron.js`

## Context

- The application already has a working chatbot (`src/services/ai/chat/chat.service.js` and `src/services/ai/chat/ragContext.service.js`) supporting document Q&A and basic medication questions.
- Existing routing depends heavily on `src/constants/keywordDictionary.js` and regex lookups, which fail when users phrase questions naturally, use synonyms, or query in Hindi, Gujarati, Marathi, or Tamil without prior translation.
- When queries span multiple domains (e.g., "Which medicines are related to my latest report?"), the current router picks only one domain and starves the LLM of the complementary context.

## Constraints

- **Language & Runtime**: Node.js CommonJS JavaScript (`require` / `module.exports`) only — strictly NO TypeScript.
- **Architecture**: Decoupled clean architecture (Route → Validation → Controller → Service → Repository → Model).
- **Messaging**: All messages must come from `src/constants/` (`messageConstants.js`, `errorConstants.js`, `chatReplies.js`).
- **Data Privacy**: Queries and context assembly must strictly scope to `req.auth.userId`.
- **Supported Languages**: English (`en`), Hindi (`hi`), Gujarati (`gu`), Marathi (`mr`), Tamil (`ta`).

## Key Decisions

| Decision                                                                                | Rationale                                                                                                                                   | Outcome   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Extend `ragContext.service.js` and `chat.service.js` rather than building a new chatbot | Protects existing working RAG flows, preserves API contracts, and prevents architectural duplication                                        | — Pending |
| Multi-intent domain set resolution                                                      | Questions can match multiple domains simultaneously (e.g. `['medications', 'documents']`), retrieving all matching contexts into the prompt | — Pending |
| Translate-first or multilingual semantic matching for intent detection                  | Enables Indian vernacular questions (Hindi, Gujarati, Marathi, Tamil) to reliably resolve to application domains                            | — Pending |

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
