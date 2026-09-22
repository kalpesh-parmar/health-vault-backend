# Roadmap: Health Vault Backend

## Overview

This roadmap details milestone **v1.0: Handle All App-Related User Questions**. It delivers a reliable, omni-domain, multilingual conversational health assistant capable of answering user questions across User Profile, Medical Profile, Documents/Reports, Medications, Schedules, Reminders, Occurrences, Notifications, and Refills in English, Hindi, Gujarati, Marathi, and Tamil using verified authenticated user context.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3, 4, 5): Planned milestone work
- Decimal phases (1.1, 2.1): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Chatbot Pipeline Characterization, Multilingual Gateway & Debug Tracing** - Trace the end-to-end chatbot lifecycle, integrate early query translation gateway for all 5 languages, and implement observability tracing to diagnose and log the "Did I miss any medicine today?" flow.
- [ ] **Phase 2: Intent & Domain Disambiguation (Occurrences vs. Prescriptions & Multi-Domain)** - Build granular domain and intent classification that cleanly separates general medications from medication occurrences, supports natural phrasing beyond exact keywords, and handles multi-domain queries.
- [ ] **Phase 3: Context Aggregation Across All Domains & Multi-Context Assembly** - Upgrade `ragContext.service.js` to fetch and assemble targeted, minimal contexts for User Profile, Medical Profile, Documents/Reports, Medications, Occurrences, Notifications, and Refills, supporting multi-domain query synthesis.
- [ ] **Phase 4: Fact Grounding, Zero-Hallucination & Document RAG Parity** - Enforce strict database grounding directives, handle missing user data gracefully in all 5 languages (explicitly stating no records exist), and preserve existing document RAG/summary flows.
- [ ] **Phase 5: Omni-Domain Multilingual Verification & Test Suite** - Implement comprehensive automated tests across occurrence status, all 7 domains, multi-domain queries, 5 languages, missing data scenarios, and regression checks.

## Phase Details

### Phase 1: Chatbot Pipeline Characterization, Multilingual Gateway & Debug Tracing

**Goal**: Trace the 10-step chatbot pipeline, integrate early query translation for Hindi, Gujarati, Marathi, and Tamil, and implement detailed trace logging to isolate the exact point where "Did I miss any medicine today?" fails.
**Depends on**: Nothing (first phase)
**Requirements**: [I18N-01, I18N-02, I18N-03, DEBUG-01, DEBUG-02]
**Success Criteria** (what must be TRUE):

1. Language detector identifies user input language (`en`, `hi`, `gu`, `mr`, `ta`) in `chat.service.js`.
2. Non-English queries are translated to English into `ctx.englishQuestion` early in `_resolveQuestion()`, enabling unified downstream processing while preserving the raw input.
3. Trace logging records every stage: Question → Language → Domain → Intent → Context Selection → DB Query → Retrieved Occurrences/Meds → Prompt → AI Response → Localized Reply.
4. The pipeline specifically traces "Did I miss any medicine today?", logging where and why it currently deviates into generic medication lists.

### Phase 2: Intent & Domain Disambiguation (Occurrences vs. Prescriptions & Multi-Domain)

**Goal**: Build an intent classifier that cleanly distinguishes between general medication information and today's medication occurrences (missed, taken, pending, upcoming, next dose, overdue), supports natural phrasing without exact keyword reliance, and handles multi-domain queries.
**Depends on**: Phase 1
**Requirements**: [OCCUR-01, OCCUR-02, OCCUR-03, OCCUR-04, INTENT-01, INTENT-04, MULTI-01]
**Success Criteria** (what must be TRUE):

1. "Did I miss any medicine today?" resolves to intent `MISSED_MEDICATION` and domain `medication_occurrence`.
2. "What medicines do I take?" resolves to intent `MEDICATION_LIST` and domain `medication`.
3. Questions asking about taken, pending, or next upcoming doses map to their respective occurrence intents.
4. Composite questions spanning multiple domains (e.g. Report + Medications, Refill + Occurrences) return an additive set of domains and intents.
5. Natural language variations and phrasing across all 5 languages map reliably without requiring rigid keyword equality.

### Phase 3: Context Aggregation Across All Domains & Multi-Context Assembly

**Goal**: Ensure `buildDependencyAwareContext()` in `ragContext.service.js` reliably queries and formats data for User Profile, Medical Profile, Documents/Reports, Medications, Occurrences, Notifications, and Refills, supporting multi-domain query synthesis.
**Depends on**: Phase 2
**Requirements**: [INTENT-02, INTENT-03, MULTI-02]
**Success Criteria** (what must be TRUE):

1. Profile data (name, DOB, age, blood group, allergies, patient code) is retrieved and formatted when profile intent is detected.
2. Notification data (unread count, recent alerts) is retrieved and formatted when notification intent is detected.
3. Occurrence queries retrieve today's actual dosage occurrences (`missed`, `taken`, `pending`, `next_dose`, `overdue`) reusing the existing occurrence calculation logic as the single source of truth.
4. Multi-domain queries assemble composite, focused contexts without loading irrelevant domains or bloating prompt size.

### Phase 4: Fact Grounding, Zero-Hallucination & Document RAG Parity

**Goal**: Enforce strict database grounding directives, handle missing user data gracefully in all 5 languages (explicitly stating no records exist), and preserve existing document RAG/summary flows.
**Depends on**: Phase 3
**Requirements**: [GROUND-01, GROUND-02, GROUND-03]
**Success Criteria** (what must be TRUE):

1. All database queries and context generation strictly scope to the authenticated `userId`.
2. When a user has zero records for a queried domain (e.g. 0 active medicines, 0 missed doses, 0 reports), the system clearly informs the user in their language that no records exist rather than hallucinating assumptions.
3. Existing single-document RAG question-answering with `documentId` and document summary generation maintain exact functionality and citations.

### Phase 5: Omni-Domain Multilingual Verification & Test Suite

**Goal**: Build a rigorous automated test suite validating occurrence status, all 7 domains, multi-domain queries, 5 languages, missing-data scenarios, and regression tests.
**Depends on**: Phase 4
**Requirements**: [TEST-01, TEST-02, TEST-03, TEST-04, TEST-05]
**Success Criteria** (what must be TRUE):

1. Automated unit tests verify occurrence-specific intents and verify they never return the generic medication list.
2. Automated unit tests verify queries across English, Hindi, Gujarati, Marathi, and Tamil.
3. Automated unit tests verify multi-domain queries and missing-data scenarios.
4. Full test suite (`npm run test:unit`) passes with 0 failures.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase                                                                            | Plans Complete | Status      | Completed |
| -------------------------------------------------------------------------------- | -------------- | ----------- | --------- |
| 1. Chatbot Pipeline Characterization, Multilingual Gateway & Debug Tracing       | 0/2            | Not started | -         |
| 2. Intent & Domain Disambiguation (Occurrences vs. Prescriptions & Multi-Domain) | 0/2            | Not started | -         |
| 3. Context Aggregation Across All Domains & Multi-Context Assembly               | 0/3            | Not started | -         |
| 4. Fact Grounding, Zero-Hallucination & Document RAG Parity                      | 0/2            | Not started | -         |
| 5. Omni-Domain Multilingual Verification & Test Suite                            | 0/2            | Not started | -         |
