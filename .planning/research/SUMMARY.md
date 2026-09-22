# Executive Summary: Omni-Domain Multilingual Chatbot

**Domain:** Multi-Domain Conversational Health Assistant
**Researched:** 2026-09-22
**Confidence:** HIGH

## Executive Summary

The Health Vault chatbot currently possesses robust underlying domain repositories (Profile, Medications, Occurrences, Refills, Documents, Notifications) and an Indic translation/detection infrastructure (FastText, IndicTrans2, Google GenAI).

However, user questions in vernacular Indian languages (Hindi, Marathi, Tamil, Gujarati) and natural language variations frequently fail because:

1. Non-English queries are not translated prior to domain classification.
2. Keyword dictionaries lack Hindi, Marathi, and Tamil mappings.
3. Strict mutual-exclusion rules (`!hasDocReference`) prevent multi-domain questions from retrieving composite context.

## Blueprint for Solution

1. **Normalized Translation Gateway:**
   Detect language early. If non-English, translate to English for internal processing, storing both `question` (raw) and `englishQuestion` (translated) in request context.

2. **Additive Multi-Domain Resolver:**
   Classify intent across all 7 application domains into an additive `Set` (e.g. `Set(['DOCUMENTS', 'MEDICATIONS'])`), eliminating mutual-exclusion suppressions.

3. **Dependency-Aware Composite Context Injection:**
   Enhance `buildDependencyAwareContext()` in `ragContext.service.js` so that single- and multi-domain questions pull factual data from all relevant repositories simultaneously.

4. **Guaranteed Zero-Hallucination Guardrails:**
   Enforce strict instructions in prompts and localized replies when user records do not exist.

5. **Multilingual Test Suite:**
   Comprehensive automated unit and characterization tests validating English, Hindi, Gujarati, Marathi, and Tamil queries across all single and multi-domain combinations.

---

_Synthesized research for: Omni-Domain Multilingual Chatbot_
_Researched: 2026-09-22_
