# Pitfalls Research: Chatbot Multi-Domain & Multilingual Failures

**Domain:** Multilingual Healthcare Chatbot
**Researched:** 2026-09-22
**Confidence:** HIGH

## Common Pitfalls & Root Cause Analysis

### 1. The Language Barrier in Intent Classification

- **Root Cause:** Intent matching algorithms rely on `cleanQuestion.includes(...)` against hardcoded string arrays (`keywordDictionary.js`) that only contain English and a few Gujarati words.
- **Symptom:** Questions in Hindi, Marathi, and Tamil completely fail to trigger any intercept or domain classification, falling back to empty context or generic "Information not found".
- **Prevention:** Perform early normalized translation: translate non-English queries to English as `englishQuestion` for internal domain detection, entity extraction, and vector matching. Preserve original query and detected language for user-facing responses.

### 2. Multi-Domain Context Starvation

- **Root Cause:** The `hasDocReference` check in `chat.service.js:976-987` explicitly suppresses `isReminderQuery`, `isRefillQuery`, and `isNotificationQuery`. If a user mentions "report" alongside "medicine" or "refill", the system forces a single-document RAG mode and starves the model of database medication and refill records.
- **Symptom:** Cross-domain questions like _"Based on my report, what medicines am I taking?"_ answer using only OCR chunks and cannot correlate with active prescriptions in the database.
- **Prevention:** Convert domain routing from a mutually-exclusive `if/else` hierarchy to an additive `Set` of active domains (e.g. `['DOCUMENTS', 'MEDICATIONS']`). When multiple domains are detected, fetch and combine all relevant context blocks.

### 3. Rigid Keyword Exactness vs Natural Language Variation

- **Root Cause:** Using exact equality or fragile `.includes()` (e.g. `AGE_KEYWORDS.includes(cleanQuestion)`). Variations such as "Tell me my age please" or "How old is my account?" fail the check.
- **Symptom:** Users feel the bot is "dumb" because slightly altering sentence structure produces a fallback failure.
- **Prevention:** Use semantic pattern matching and synonym sets (`src/utils/synonyms.js:containsEntity`) rather than exact array equality.

### 4. Hallucination on Missing User Records

- **Root Cause:** When a user queries a domain where they have no database records (e.g. no uploaded documents or no active medications), generic prompts can lead the LLM to invent placeholder medications or give misleading advice.
- **Symptom:** Generating fictional prescriptions or dates.
- **Prevention:** Inject explicit negative constraints into the prompt context:
  `=== ACTIVE PROFILE MEDICATIONS: 0 records found. STRICT INSTRUCTION: Tell the user they have no active medications. DO NOT invent medicines.`
  For direct intercepts, return verified pre-localized "no records found" templates from `chatReplies.js`.

### 5. Translation Latency and Circular Degradation

- **Root Cause:** Translating back and forth multiple times or translating large paragraphs sentence-by-sentence synchronously degrades response time.
- **Prevention:** Perform query translation once at input resolution; keep domain prompts in English; stream translated chunks or let the multilingual model generate natively in the target language when possible.

---

_Pitfalls research for: Multilingual Healthcare Chatbot_
_Researched: 2026-09-22_
