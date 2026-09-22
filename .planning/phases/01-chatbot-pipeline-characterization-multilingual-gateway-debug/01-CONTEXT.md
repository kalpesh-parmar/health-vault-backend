# Phase 1: Chatbot Pipeline Characterization, Multilingual Gateway & Debug Tracing - Context

**Gathered:** 2026-09-22
**Status:** Ready for planning
**Source:** User Milestone Specification & Codebase Investigation

<domain>
## Phase Boundary

Phase 1 establishes the diagnostic observability and multilingual foundation for the chatbot.
It characterizes the 10-step lifecycle of chat messages in `src/services/ai/chat/chat.service.js`, isolates and instruments the exact failure point for the missed medication bug ("Did I miss any medicine today?"), standardizes language normalization across English, Hindi, Gujarati, Marathi, and Tamil, and integrates early query translation into `ctx.englishQuestion` for downstream intent and context processing while preserving raw question and response language.

</domain>

<decisions>
## Implementation Decisions

### 1. 10-Step Pipeline Instrumentation & Debug Tracing (DEBUG-01, DEBUG-02)

- Instrument `chat.service.js` with structured trace logging through `debugLogger.info`:
  1. `question`: raw input received
  2. `detectedLanguage`: language identified via ML detector / script heuristics
  3. `englishQuestion`: translated/normalized English representation
  4. `detectedDomains`: Set of active domains (e.g. `medication_occurrence`, `medication`)
  5. `detectedIntents`: List of active intents (e.g. `MISSED_MEDICATION`)
  6. `selectedContext`: which context builders were triggered
  7. `dbQueries`: records retrieved from `medicationRepository`, `occurrenceRepository` (taken, missed, pending)
  8. `generatedContext`: formatted context string passed to LLM
  9. `finalPrompt`: full prompt sent to LLM
  10. `finalResponse`: raw LLM output and localized response
- Specifically trace "Did I miss any medicine today?" (and its vernacular equivalents), verifying where it previously fell back to `allMeds = await medicationRepository.findAll(userId)` in `_handleReminderIntercept` instead of reporting missed occurrences.

### 2. Early Translation Gateway (I18N-01, I18N-02, I18N-03)

- In `_resolveQuestion(ctx)` and `_resolveLanguage(ctx)`:
  - Detect query language using `aiClient.detectLanguage` / fast script check for `hi`, `gu`, `mr`, `ta`, `en`.
  - For non-English inputs (`hi`, `gu`, `mr`, `ta`), translate to English into `ctx.englishQuestion` via `aiClient.translate()` early before any keyword checks or intent analysis.
  - Preserve `ctx.question` (original text) for user session history and `ctx.detectedLanguage` for response generation/translation.
- In `src/utils/commonUtils.js`:
  - Ensure `normalizeLanguage` maps aliases consistently (`english` -> `en`, `gujarati` -> `gu`, `hindi` -> `hi`, `marathi` -> `mr`, `tamil` -> `ta`).

### 3. Non-Breaking Parity

- Keep all existing document RAG, triage emergency checks, and session attachment logic intact.
- Do not modify database schemas or onboarding state engine.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Chat Pipeline & AI Client

- `src/services/ai/chat/chat.service.js` — Core 10-step chat lifecycle and intercept handlers.
- `src/services/ai/chat/ragContext.service.js` — Domain graph detector and dependency-aware context builder.
- `src/services/ai/clients/aiClient.service.js` — Translation and language detection client wrappers.
- `src/constants/keywordDictionary.js` — Keyword definitions across domains and languages.
- `src/utils/commonUtils.js` — Language normalization utility.

</canonical_refs>

<specifics>
## Specific Ideas

- The missed medication bug diagnosis:
  In `_handleReminderIntercept`:
  ```javascript
  if (!occurrences || occurrences.length === 0) {
    // BUG: Falls back to medicationRepository.findAll(userId) and prints daily medicine list!
  }
  ```
  And when occurrences DO exist, it formats all occurrences together rather than filtering by missed status. Phase 1 adds explicit tracing for this path so that Phase 2 and Phase 3 can cleanly route and format occurrence intents.
- Early query translation gateway ensures questions like:
  - Hindi: "क्या मैंने आज कोई दवा मिस की है?" -> "Did I miss any medicine today?"
  - Gujarati: "શું મેં આજે કોઈ દવા ચૂકી છે?" -> "Did I miss any medicine today?"
  - Marathi: "मी आज कोणते औषध चुकवले?" -> "Did I miss any medicine today?"
  - Tamil: "இன்று நான் ஏதாவது மருந்தை தவறவிட்டேனா?" -> "Did I miss any medicine today?"
    All normalize to English for downstream classification while preserving the response language.

</specifics>

<deferred>
## Deferred Ideas

- Phase 2: Additive omni-domain intent classification & occurrence vs medication disambiguation.
- Phase 3: Comprehensive context aggregation across Profile, Documents, Medications, Occurrences, Refills, Notifications.
- Phase 4: Zero-hallucination fact grounding.
- Phase 5: Automated test suite across all domains and 5 languages.

</deferred>
