# Roadmap: Health Vault Backend

## Overview

This roadmap details milestone **v1.1: Precise Omni-Domain Answers, Occurrence Accuracy & 60-Question Multilingual Validation**. It resolves context inaccuracies, occurrence calculations, and noisy prompt metadata to deliver strictly concise, exact answers across Profile, Medications, Reminders, Notifications, Refills, and Documents in English, Gujarati, Hindi, Marathi, and Tamil, validated by a comprehensive 60-question test matrix without breaking existing application flows.

## Phases

- [x] **Phase 1: Medication End Date Integrity & Medication Question Handling** - Use stored `endDate` from the medications table directly in context and prompt synthesis, and ensure accurate answering for all 14 core medication questions (dosages, timing, active/inactive, food instructions, counts).
- [x] **Phase 2: Occurrence Status Engine, Count Accuracy & Targeted Reminder Answers** - Fix occurrence status resolution so taken doses are never counted as missed, overdue un-taken doses are counted as missed, accurate counts are generated, and queries return only the requested slice (e.g. only missed doses, only the next reminder).
- [x] **Phase 3: Refill Grounding & Document Artifact Sanitization** - Remove "Refills Remaining - N/A" by connecting real refill records to chat context, return verified document/report names, and sanitize internal prompt artifacts like `(the current page is 1 of 1)`.
- [x] **Phase 4: Profile & Notification Grounding, Concise Formatting & Multilingual Parity** - Ensure Profile and Notification queries return complete authenticated data, format all chatbot answers in a strictly concise bulleted style, support all 5 languages (English, Gujarati, Hindi, Marathi, Tamil), and ensure zero regressions in onboarding or document RAG flows.
- [ ] **Phase 5: 60-Question Automated Validation Suite & Matrix Verification** - Implement and execute comprehensive automated tests validating all 60 specific test questions across all 6 domains and all 5 languages.

## Phase Details

### Phase 1: Medication End Date Integrity & Medication Question Handling

**Goal**: Use stored `endDate` from the `medications` table directly in context and replies, and ensure accurate answering for all 14 core medication questions.  
**Depends on**: Nothing (first phase of v1.1)  
**Requirements**: [MED-01, MED-02]  
**Success Criteria**:
1. Medication context builders retrieve and expose stored `endDate` without dynamic recalculation.
2. Questions about before/after food, morning/night, and active/inactive medicines correctly extract matching subset filters.
3. All 14 medication test questions return precise, accurate medication details.

### Phase 2: Occurrence Status Engine, Count Accuracy & Targeted Reminder Answers

**Goal**: Fix occurrence status resolution so taken doses are never counted as missed, overdue un-taken doses are counted as missed, accurate counts are generated, and queries return only the requested slice.  
**Depends on**: Phase 1  
**Requirements**: [OCCUR-01, OCCUR-02, OCCUR-03, OCCUR-04, OCCUR-05]  
**Success Criteria**:
1. Taken occurrences are strictly excluded from missed tallies.
2. Overdue non-taken occurrences are properly classified and counted as missed.
3. Missed medication queries return only missed occurrences rather than general medication dumps.
4. Next reminder query returns strictly the single next upcoming reminder.
5. All 10 reminder/occurrence test questions return exact answers.

### Phase 3: Refill Grounding & Document Artifact Sanitization

**Goal**: Remove "Refills Remaining - N/A" by connecting real refill records to chat context, return verified document/report names, and sanitize internal prompt artifacts like `(the current page is 1 of 1)`.  
**Depends on**: Phase 2  
**Requirements**: [REFILL-01, REFILL-02, DOC-01, DOC-02, DOC-03]  
**Success Criteria**:
1. Refill queries fetch actual refill records from the database without emitting placeholder "N/A" strings.
2. Document queries list verified document/report titles matching uploaded patient files.
3. Internal artifact text such as `(the current page is 1 of 1)` is completely stripped from responses.
4. All 10 refill and all 10 document test questions return clean, exact responses.

### Phase 4: Profile & Notification Grounding, Concise Formatting & Multilingual Parity

**Goal**: Ensure Profile and Notification queries return complete authenticated data, format all chatbot answers in a strictly concise bulleted style, support all 5 languages (English, Gujarati, Hindi, Marathi, Tamil), and ensure zero regressions in onboarding or document RAG flows.  
**Depends on**: Phase 3  
**Requirements**: [PROF-01, NOTIF-01, I18N-01, STYLE-01, FLOW-01]  
**Success Criteria**:
1. Profile questions accurately return age, DOB, blood group, phone, email, and personal information.
2. Notification questions accurately return unread counts, recent alerts, and latest notifications.
3. System prompts enforce strictly concise, direct answers with zero filler or system metadata.
4. Vernacular queries in Gujarati, Hindi, Marathi, and Tamil yield equivalent accurate answers.
5. Onboarding state machine, OCR processing, and document RAG continue passing without side effects.

### Phase 5: 60-Question Automated Validation Suite & Matrix Verification

**Goal**: Implement and execute comprehensive automated tests validating all 60 specific test questions across all 6 domains and all 5 languages.  
**Depends on**: Phase 4  
**Requirements**: [TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06, TEST-07]  
**Success Criteria**:
1. Automated unit test suite verifies all 10 Profile questions.
2. Automated unit test suite verifies all 14 Medication questions.
3. Automated unit test suite verifies all 10 Reminder/Occurrence questions.
4. Automated unit test suite verifies all 10 Notification questions.
5. Automated unit test suite verifies all 10 Refill questions.
6. Automated unit test suite verifies all 10 Document questions.
7. All 60 test cases pass across English, Gujarati, Hindi, Marathi, and Tamil with 100% pass rate in `npm run test:unit`.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
| --- | --- | --- | --- |
| 1. Medication End Date Integrity & Medication Question Handling | 2/2 | Complete | 2026-09-24 |
| 2. Occurrence Status Engine, Count Accuracy & Targeted Reminder Answers | 2/2 | Complete | 2026-09-24 |
| 3. Refill Grounding & Document Artifact Sanitization | 2/2 | Complete | 2026-09-24 |
| 4. Profile & Notification Grounding, Concise Formatting & Multilingual Parity | 2/2 | Complete | 2026-09-24 |
| 5. 60-Question Automated Validation Suite & Matrix Verification | 0/2 | Ready | - |
