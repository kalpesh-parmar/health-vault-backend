# Roadmap: Health Vault Backend

## Overview

This roadmap details milestone **v1.0: Handle All App-Related User Questions (Omni-Domain Multilingual Chatbot)**. It delivers an end-to-end, multi-domain conversational health assistant capable of answering user questions across Profile, Documents, Medications, Schedules, Reminders, Occurrences, Refills, and Notifications in English, Hindi, Gujarati, Marathi, and Tamil using verified user context.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3, 4, 5): Planned milestone work
- Decimal phases (1.1, 2.1): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Chatbot Pipeline Audit & Multilingual Translation Gateway** - Implement early query translation for Hindi, Gujarati, Marathi, and Tamil, establishing normalized `englishQuestion` for classification while preserving preferred response language.
- [ ] **Phase 2: Omni-Domain Intent Detection & Semantic Routing** - Replace rigid string equality and exclusionary filters (`!hasDocReference`) with an additive multi-domain classifier supporting natural phrasing and cross-cutting intents.
- [ ] **Phase 3: Domain Context Aggregation & Multi-Context Assembly** - Upgrade `buildDependencyAwareContext()` in `ragContext.service.js` to fetch and assemble data for all 7 application domains, supporting composite multi-domain prompts.
- [ ] **Phase 4: Fact Grounding, Anti-Hallucination & Document RAG Parity** - Enforce strict database grounding directives, handle missing user data gracefully in all 5 languages, and preserve existing document RAG/summary flows.
- [ ] **Phase 5: Multilingual Omni-Domain Automated Test Suite** - Implement comprehensive unit and integration tests across all 5 languages, single/multi-domain queries, missing-record fallbacks, and regression checks.

## Phase Details

### Phase 1: Chatbot Pipeline Audit & Multilingual Translation Gateway

**Goal**: Ensure non-English questions (Hindi, Gujarati, Marathi, Tamil) are translated early in the pipeline so downstream intent routing and context builders operate on full vocabulary.
**Depends on**: Nothing (first phase)
**Requirements**: [I18N-01, I18N-02, I18N-03]
**Success Criteria** (what must be TRUE):

1. Language detector identifies user input language (`en`, `hi`, `gu`, `mr`, `ta`) in `chat.service.js:_resolveLanguage()`.
2. Non-English queries are translated to English into `ctx.englishQuestion` via `aiClient.translate()` early in `_resolveQuestion()`.
3. Raw query (`ctx.question`) and detected language are preserved for history and final response translation.
   **Plans**: 2 plans

Plans:

**Wave 1:**

- [ ] 01-01: Audit 10-step chat lifecycle, standardize language normalization in commonUtils.js, and integrate early query translation in chat.service.js.

**Wave 2 (blocked on Wave 1 completion):**

- [ ] 01-02: Expand 5-language keyword dictionary in keywordDictionary.js, fix script mislabeling, and enforce detectedLanguage on template intercepts in chat.service.js.

### Phase 2: Omni-Domain Intent Detection & Semantic Routing

**Goal**: Build an additive multi-domain intent classifier that identifies single- and multi-domain queries across all application areas without keyword brittleness.
**Depends on**: Phase 1
**Requirements**: [ROUTING-01, ROUTING-02, ROUTING-03]
**Success Criteria** (what must be TRUE):

1. Intent classifier returns an additive `Set` of active domains rather than a single mutually-exclusive enum.
2. Queries mentioning documents and medications simultaneously (e.g. "Based on my report, what medicines am I taking?") activate both `DOCUMENTS` and `MEDICATIONS` domains.
3. Natural language variations and synonyms resolve correctly without requiring exact string equality.
   **Plans**: 2 plans

Plans:

- [ ] 02-01: Refactor `_tryIntercepts()` and `_analyzeIntent()` in `chat.service.js` to eliminate domain mutual-exclusion suppressions.
- [ ] 02-02: Expand semantic intent matcher in `ragContext.service.js:detectContextGraph()` to support multi-domain detection on normalized English queries.

### Phase 3: Domain Context Aggregation & Multi-Context Assembly

**Goal**: Ensure `buildDependencyAwareContext()` reliably fetches and formats data for Profile, Documents, Medications, Reminders, Occurrences, Refills, and Notifications.
**Depends on**: Phase 2
**Requirements**: [CTX-01, CTX-02, CTX-03, CTX-04, CTX-05, CTX-06, CTX-07]
**Success Criteria** (what must be TRUE):

1. Profile data (name, DOB, age, blood group, allergies, patient code, login type) is injected when profile intent is present.
2. Medications, today's dosage occurrences (taken/missed/pending), and refill stock levels are accurately retrieved and injected.
3. Recent medical reports, diagnoses, and lab test results are injected when document intent is present.
4. Composite queries aggregate all matching domain blocks into `patientContextStr` for LLM synthesis.
   **Plans**: 3 plans

Plans:

- [ ] 03-01: Enhance Profile, Notification, and Document context blocks in `ragContext.service.js`.
- [ ] 03-02: Enhance Medication, Occurrence (today's schedule/taken/missed), and Refill stock context blocks in `ragContext.service.js`.
- [ ] 03-03: Integrate composite multi-domain context assembly and pass to LLM prompt.

### Phase 4: Fact Grounding, Anti-Hallucination & Document RAG Parity

**Goal**: Enforce strict fact grounding in LLM prompts, provide polite localized messages when records are missing, and preserve existing document RAG/summary flows.
**Depends on**: Phase 3
**Requirements**: [GROUND-01, GROUND-02, GROUND-03]
**Success Criteria** (what must be TRUE):

1. If a user has zero records for a queried domain (e.g. 0 active medicines), system clearly states no records exist in Health Vault rather than hallucinating.
2. System instructions strictly forbid fabricating clinical data not present in the injected database context.
3. Existing single-document RAG question-answering with `documentId` maintains exact citation and relevance behavior.
   **Plans**: 2 plans

Plans:

- [ ] 04-01: Enforce zero-hallucination prompt instructions and pre-localized missing-data templates in `chatReplies.js` and `prompts.js`.
- [ ] 04-02: Verify and protect existing document RAG, summary generation, and vector retrieval paths from regression.

### Phase 5: Multilingual Omni-Domain Automated Test Suite

**Goal**: Build a rigorous test suite validating the chatbot across all 5 languages, single- and multi-domain questions, missing-data scenarios, and regression tests.
**Depends on**: Phase 4
**Requirements**: [TEST-01, TEST-02, TEST-03, TEST-04]
**Success Criteria** (what must be TRUE):

1. Automated tests verify domain resolution and factual answering for English, Hindi, Gujarati, Marathi, and Tamil questions.
2. Automated tests verify multi-domain questions (e.g. Report + Medications, Refill + Occurrences).
3. Automated tests verify missing-data handling (user with 0 medications, user without DOB).
4. Full test suite (`npm run test:unit`) passes with 0 failures.
   **Plans**: 2 plans

Plans:

- [ ] 05-01: Implement multilingual omni-domain unit tests in `tests/unit/` covering all 7 domains across 5 languages.
- [ ] 05-02: Execute full test suite (`npm run test:unit`) and verify zero regressions.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase                                                        | Plans Complete | Status      | Completed |
| ------------------------------------------------------------ | -------------- | ----------- | --------- |
| 1. Chatbot Pipeline Audit & Multilingual Translation Gateway | 0/2            | Not started | -         |
| 2. Omni-Domain Intent Detection & Semantic Routing           | 0/2            | Not started | -         |
| 3. Domain Context Aggregation & Multi-Context Assembly       | 0/3            | Not started | -         |
| 4. Fact Grounding, Anti-Hallucination & Document RAG Parity  | 0/2            | Not started | -         |
| 5. Multilingual Omni-Domain Automated Test Suite             | 0/2            | Not started | -         |
