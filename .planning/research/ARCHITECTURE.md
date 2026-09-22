# Architecture Research: End-to-End Chatbot Pipeline Analysis

**Domain:** Multilingual Omni-Domain Healthcare Chatbot
**Researched:** 2026-09-22
**Confidence:** HIGH

## 1. End-to-End Analysis of the 10-Step Chatbot Flow

The Health Vault chatbot flow traverses 10 discrete stages across controllers, services, repositories, external AI services, and database tables.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. INGESTION: `POST /chat/message` (`chatSession.controller.js`)             │
│    - Extracts `question`, `sessionId`, `documentId`, `preferredLanguage`    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. LANGUAGE DETECTION: `_resolveLanguage()` (`chat.service.js:503-553`)     │
│    - FastText / GlotLID ML model via `aiClient.detectLanguage(question)`     │
│    - Resolves: `english`, `hindi`, `gujarati`, `marathi`, `tamil`            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. TRANSLATION (CURRENTLY MISSING IN CLASSIFICATION):                        │
│    - Current flaw: Raw non-English question is NOT translated to English     │
│      before classification. `retrievalQuery` remains non-English.           │
│    - Target fix: Generate `translatedEnglishQuestion` for intent & RAG       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. DOMAIN / INTENT DETECTION: `_tryIntercepts()` & `_analyzeIntent()`       │
│    - Current flaw: Checks `cleanQuestion` against hardcoded string arrays    │
│      (`explicitReminderKeywords`, `keywordDictionary`). Lacks Hindi/Tamil/  │
│      Marathi keywords; fails on natural paraphrasing; blocks multi-domain.  │
│    - Target fix: Semantic multi-domain classification on translated query.  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. CONTEXT MAPPING: `detectContextGraph()` (`ragContext.service.js:93-132`) │
│    - Identifies active domain set: `PROFILE`, `MEDICATIONS`, `REMINDERS`,   │
│      `REFILLS`, `DOCUMENTS`, `NOTIFICATIONS`                                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. DATABASE RETRIEVAL: Parallel Domain Fetching (`ragContext.service.js`)   │
│    - `patientRepository.findById(userId)`                                   │
│    - `medicationRepository.findAll(userId)`                                 │
│    - `occurrenceRepository.findOccurrencesByUserIdAndDateRange(...)`        │
│    - `refillRepository.findLatestRefillByMedicationId(...)`                 │
│    - `documentRepository.getSummaryByUserId(...)` / vector chunks           │
│    - `notificationRepository.list({ userId })`                              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. CONTEXT ASSEMBLY: `buildDependencyAwareContext()`                        │
│    - Structured Markdown text blocks injected into `ctx.patientContextStr`  │
│    - Injects strict grounding directives ("Use ONLY official database...")  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. LLM GENERATION: `qwenHealthChat()` / Gemini Ingestion                    │
│    - Feeds history, user query, and `patientContextStr`                     │
│    - System instruction forces strict reliance on provided context          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 9. RESPONSE TRANSLATION / LOCALIZATION:                                     │
│    - If LLM generated in English or intercepted via template, translates    │
│      via `aiClient.translate(text, "english", detectedLanguage)`            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 10. CLIENT DISPATCH: `_saveAndReturn()`                                     │
│     - Appends user and assistant messages to `chatSessionRepository`        │
│     - Returns JSON `{ reply, mode, citations, options }`                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. Identified Failure Points in Existing Implementation

1. **Non-English Input Bypass:**
   - When a user asks in Hindi (`मेरी दवाई कब लेनी है?`), Marathi (`माझी औषधे कोणती आहेत?`), or Tamil (`என் மருந்து எப்போது எடுக்க வேண்டும்?`), the language detection correctly marks `detectedLanguage = "hindi"|"marathi"|"tamil"`.
   - However, `_tryIntercepts()` and `detectContextGraph()` perform `.includes()` or `hasAny()` matching on the raw non-English text against dictionaries that contain almost exclusively English (and some Gujarati) phrases.
   - Result: Domain detection returns empty or defaults to generic general health without pulling medication or reminder records.

2. **Rigid String Matching & Paraphrasing Blindness:**
   - In `_tryIntercepts()`:
     - `AGE_KEYWORDS.includes(cleanQuestion)` requires exact matches like "how old am i". Asking "what is my age" or "could you please tell me how old i am" misses the intercept.
     - `explicitReminderKeywords` contains specific compound nouns ("today medicine list"), but natural queries ("when should I take my pills?", "did I miss any pills today?") fail the keyword check.

3. **Multi-Domain Conflict / Exclusion Logic:**
   - In `chat.service.js:976-987`:
     ```javascript
     const hasDocReference = (hasAny(lowerQuestion, keywordDictionary.DOCUMENT) && ...) || ...;
     const isReminderQuery = (...) && !hasDocReference;
     const isRefillQuery = (...) && !hasDocReference;
     ```
   - If a query mentions reports or documents alongside medications (e.g. _"Based on my latest report, which medicines am I currently taking?"_), `hasDocReference` becomes `true`, which **actively disables** `isReminderQuery` and `isRefillQuery`, routing solely to vector search over document chunks. Active prescriptions in `medications` table are never fetched!

4. **Document RAG vs Database Context Disconnect:**
   - `intent` is binary (`GENERAL` vs `DOCUMENT`).
   - If `intent === "DOCUMENT"`, the service executes vector search against `embeddings` / `document_chunks` table and neglects database tables (`medications`, `reminders`, `refills`).
   - If `intent === "GENERAL"`, it executes `qwenHealthChat` with database context, but omits specific document citations.

## 3. Target Solution Architecture

1. **Early Normalized Translation Pipeline:**
   - In `_resolveQuestion()`, if `detectedLanguage !== "english"`, execute `aiClient.translate(question, detectedLanguage, "english")` to produce `ctx.englishQuestion`.
   - Use `englishQuestion` for semantic domain classification and vector embedding search, while preserving `originalQuestion` and `detectedLanguage` for conversation history and final response delivery.

2. **Unified Semantic Multi-Domain Classifier:**
   - Replace brittle hardcoded arrays with a unified domain resolver that evaluates intent across all 7 domains:
     - `PROFILE` (name, age, DOB, blood group, allergies, login method, patient code)
     - `DOCUMENTS` (uploaded reports, diagnoses, lab tests, doctor names)
     - `MEDICATIONS` (active prescriptions, dosage, frequency, food instructions)
     - `SCHEDULES_REMINDERS` (scheduled timings, alerts)
     - `OCCURRENCES` (today's taken, missed, overdue, pending doses)
     - `REFILLS` (remaining quantities, refill dates, low stock)
     - `NOTIFICATIONS` (unread/read alerts)
   - Support simultaneous multi-domain resolution (e.g. `Set(['DOCUMENTS', 'MEDICATIONS'])`).

3. **Composite Context Synthesis:**
   - `buildDependencyAwareContext()` retrieves data for all active domains in parallel using existing repositories.
   - Multi-domain prompts seamlessly combine document report findings with database medication schedules.

4. **Hallucination-Proof Direct Answering:**
   - Clear system instructions and fallback replies: if a user asks about reminders and has 0 reminders scheduled, explicitly reply that no reminders are scheduled rather than inventing a schedule.

---

_Architecture analysis: 2026-09-22_
