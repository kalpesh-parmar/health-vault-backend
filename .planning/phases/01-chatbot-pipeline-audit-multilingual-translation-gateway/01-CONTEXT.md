# Phase 1: Chatbot Pipeline Audit & Multilingual Translation Gateway - Context

**Gathered:** 2026-09-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 establishes the multilingual foundation and audit for the omni-domain chatbot. It formalizes the 10-step chatbot pipeline, ensures accurate language detection across all 5 supported languages (English, Hindi, Gujarati, Marathi, Tamil), and sets up query normalization and direct native-language response delivery without post-generation translation degradation.

</domain>

<decisions>
## Implementation Decisions

### Response Generation & Translation Strategy

- **D-01 (Direct Native LLM Generation):** The LLM must answer directly in the user's detected language (`english`, `hindi`, `gujarati`, `marathi`, `tamil`) via prompt instructions. There is NO post-generation translation step for the AI model output.
- **D-02 (Pre-Localized Template Intercepts):** Deterministic intercepted replies (Profile, Age, Summaries, Reminders, Refills, Notifications) directly use the pre-localized i18n dictionaries in `src/constants/chatReplies.js` without translation hops.
- **D-03 (Multi-Language Keyword & Domain Matching):** Expand `keywordDictionary.js` to define comprehensive keywords across all 5 languages (English, Hindi, Gujarati, Marathi, Tamil) for each application domain, so queries in any supported language directly trigger their corresponding domain and database retrieval.
- **D-04 (Auxiliary Query Translation Fallback):** When a user asks in a non-English language and does not match exact vernacular keywords, an auxiliary internal translation can produce `ctx.englishQuestion` for intent resolution and vector retrieval, but the final response generation remains native to the user's language.

### the agent's Discretion

- Exact mapping structure between language codes (`hi`, `gu`, `mr`, `ta`, `en`) and full names (`hindi`, `gujarati`, `marathi`, `tamil`, `english`) in `src/utils/commonUtils.js:normalizeLanguage()`.
- Error handling and timeouts if language detection service is slow (fallback to patient's `preferredLanguage` or English).

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Chat Service & Lifecycle

- `src/services/ai/chat/chat.service.js` — Core chat coordinator, language resolution (`_resolveLanguage`), intercepts (`_tryIntercepts`), intent analyzer (`_analyzeIntent`), and LLM invocation (`_generateAnswer`).
- `src/services/ai/chat/ragContext.service.js` — Domain context builder (`buildDependencyAwareContext`) and context graph detector (`detectContextGraph`).

### Localization & Keywords

- `src/constants/keywordDictionary.js` — Domain keyword lists (`PROFILE`, `MEDICATION`, `REMINDER`, `REFILL`, `NOTIFICATION`, `DOCUMENT`).
- `src/constants/chatReplies.js` — Pre-localized response templates supporting `english`, `gujarati`, `hindi`, `marathi`, and `tamil`.
- `src/utils/commonUtils.js` — `normalizeLanguage` helper function.

### External AI Microservice

- `src/clients/aiServiceClient.js` — Methods `detectLanguage({ text })` and `translate({ text, srcLang, tgtLang })`.
- `ai-service/app/api/v1/routes/language.py` — FastText/GlotLID language detection endpoint.
- `ai-service/app/api/v1/routes/translation.py` — IndicTrans2 machine translation endpoint.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `aiClient.detectLanguage(question)` in `src/services/ai/clients/aiClient.service.js` is already integrated with the Python AI microservice.
- `chatReplies.js` already contains translation dictionaries for English, Hindi, Gujarati, Marathi, and Tamil for `NO_CONTEXT_REPLY_I18N`, `REQUIRE_SELECTION_I18N`, `AGE_REPLY_I18N`, `SUMMARY_LABELS_I18N`, and `REPORT_PROCESSING_I18N`.
- `streamTextLikeChat()` in `chat.service.js` provides word-by-word streaming chunk delivery to mobile clients.

### Established Patterns

- Language resolution cascades: `passedLang` (request body) → `patient.preferredLanguage` → `userOnboarding.preferredLanguage` → ML `detectLanguage(question)` → fallback `"english"`.
- Clean Architecture: Chat service consumes repositories and external AI clients; controllers remain thin.

### Integration Points

- `src/services/ai/chat/chat.service.js:503-553` (`_resolveLanguage`): Primary integration point for detected language resolution and context assignment.
- `src/services/ai/chat/chat.service.js:494-501` (`_resolveQuestion`): Query normalization and auxiliary translation attachment.

</code_context>

<specifics>
## Specific Ideas

- "In current flow for every language keywords are defined, so match detected user language targeted query, and in db stored values return. If LLM called, answer is generated directly in that language."
- Avoid post-translating the LLM output — instruct the LLM to write directly in the user's language using the prompt context.

</specifics>

<deferred>
## Deferred Ideas

- Voice-to-voice direct conversation (deferred to v2 milestone).
- Chat-based mutations / action execution (deferred to v2 milestone).

</deferred>

---

_Phase: 1-Chatbot Pipeline Audit & Multilingual Translation Gateway_
_Context gathered: 2026-09-22_
