# Phase 1: Chatbot Pipeline Audit & Multilingual Translation Gateway - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-22
**Phase:** 01-chatbot-pipeline-audit-multilingual-translation-gateway
**Areas discussed:** Language Detection, Response Generation Flow, Multilingual Keywords Strategy

---

## Response Generation Flow & Translation Timing

| Option                       | Description                                                                                            | Selected |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| Post-Generation Translation  | Translate LLM response from English to user's language using IndicTrans2                               |          |
| Direct Native LLM Generation | Instruct LLM to directly answer in user's detected language; pre-localized dictionaries for intercepts | ✓        |

**User's choice:** "dont do changes in flow like current flow is detected language and model give answer in direct that language... in current flow for every language keywords defined so match detected user language targeted query and in db stored values return, if llm call answer generated directly by that language"
**Notes:** User strongly directed keeping response generation native in the detected language without translation hops, with multi-language keywords defined to match user intent directly.

---

## Multi-Language Keyword & Domain Matching

| Option                                          | Description                                                                                                                              | Selected |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| English-Only Keywords with Required Translation | Always translate query to English before matching keyword dictionaries                                                                   |          |
| Native Multi-Language Keyword Sets              | Define keywords across English, Hindi, Gujarati, Marathi, and Tamil directly in keywordDictionary.js with auxiliary translation fallback | ✓        |

**User's choice:** Native Multi-Language Keyword Sets across all 5 supported languages.
**Notes:** Matches the application's supported language roster (English, Hindi, Gujarati, Marathi, Tamil) and prevents unnecessary translation latency on common medical and schedule queries.

---

## the agent's Discretion

- Standardization of language aliases (`hi`, `gu`, `mr`, `ta`, `en`) in `normalizeLanguage`.
- Timeout and error fallback when external language detector is unavailable.

## Deferred Ideas

- Voice input/output integration (deferred to v2 milestone).
- Chat-based action execution (deferred to v2 milestone).
