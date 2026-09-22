# Phase 1: Chatbot Pipeline Characterization, Multilingual Gateway & Debug Tracing - Research

**Date:** 2026-09-22
**Status:** Completed
**Scope:** Phase 1 (Pipeline Tracing, Multilingual Gateway, Observability)

## 1. Executive Summary

This research investigates the end-to-end chatbot processing flow in `src/services/ai/chat/chat.service.js` and `src/services/ai/chat/ragContext.service.js`. It isolates the exact mechanisms responsible for the failure where the query _"Did I miss any medicine today?"_ is answered with the user's regular medication list instead of today's actual missed medication occurrences. Furthermore, it outlines the architecture for early query translation and complete 10-step trace logging across all 5 supported languages (`en`, `hi`, `gu`, `mr`, `ta`).

---

## 2. The 10-Step Chatbot Lifecycle

When `sendMessage(payload)` is invoked from `chatSession.controller.js`:

1. **Step 1: Question Sanitization & Session Context (`_resolveQuestion`)**
   - Sanitizes raw text string, extracts retrieval query, and normalizes input.
2. **Step 2: Language Resolution (`_resolveLanguage`)**
   - Identifies user language from `passedLang`, patient preferred language in DB, or ML language detector (`aiClient.detectLanguage`).
3. **Step 3: Session Resolution (`_resolveSession`)**
   - Loads or creates chat session in `chatSessionRepository`, fetches patient record `p` from `patientRepository`.
4. **Step 4: Pre-LLM Deterministic Intercepts (`_tryIntercepts`)**
   - Evaluates hard-coded keyword rules for:
     - Intercept 1: Age (`AGE_KEYWORDS`)
     - Intercept 2: Document Summary (`SUMMARY_KEYWORDS`)
     - Intercept 3: Profile Query (`isProfileQuestion`)
     - Intercept 4: Medication Reminders & Today's Schedule (`isReminderQuery`)
     - Intercept 5: Medication Refills & Stock (`isRefillQuery`)
     - Intercept 6: Notifications (`isNotificationQuery`)
     - Intercept 7: Medication List (`isMedicationListRequest`)
     - Intercept 8: Document Catalog Listing (`isDocumentCatalogListing`)
5. **Step 5: Intent & Domain Classification (`_analyzeIntent`)**
   - Evaluates whether query is `GENERAL`, `DOCUMENT`, or `COMPARE`.
   - **Flaw**: Lacks fine-grained intent granularity (`MISSED_MEDICATION` vs `MEDICATION_LIST`).
6. **Step 6: Document Resolution (`_resolveDocuments`)**
   - Handles explicit document attachments and vector candidate selection.
7. **Step 7: Context Assembly (`_buildHistoryAndContext`)**
   - Calls `buildDependencyAwareContext(userId, question, ...)` in `ragContext.service.js`.
   - Checks `detectContextGraph(question)` which tests `keywordDictionary` arrays and returns a `Set<string>` of domains (`MEDICATIONS`, `REMINDERS`, `DOCUMENTS`, etc.).
8. **Step 8: LLM Generation (`_generateAnswer`)**
   - Invokes `qwenHealthChat` with assembled `patientContextStr` and system prompt.
9. **Step 9: Output Localization & Storage (`_saveAndReturn`)**
   - Saves exchange to `chatSessionRepository` and returns response object.
10. **Step 10: Client Delivery (Controller / SSE)**
    - Delivers result as SSE event stream or JSON payload.

---

## 3. Root Cause Analysis: The Missed Medication Bug

### Why does _"Did I miss any medicine today?"_ return the normal medication list?

There are two distinct failure pathways in the current codebase:

### Path A: Trapped by `_handleReminderIntercept` (Lines 990-1003 & 1497-1575)

1. In `_tryIntercepts`, line 990:
   ```javascript
   const isReminderQuery =
     (hasAny(lowerQuestion, explicitReminderKeywords) ||
       hasAny(normalizedQuestion, explicitReminderKeywords) ||
       ((lowerQuestion.includes("today") || lowerQuestion.includes("schedule")) &&
         (hasAny(lowerQuestion, keywordDictionary.REMINDER) ||
           lowerQuestion.includes("medication") ||
           lowerQuestion.includes("medicine")))) &&
     !hasDocReference &&
     !isConversationalOrAdvice &&
     !hasAny(lowerQuestion, keywordDictionary.PROFILE_EXCLUSIONS);
   ```
   _"Did I miss any medicine today?"_ contains `"today"` and `"medicine"`. Therefore, `isReminderQuery` evaluates to `true`.
2. Execution routes to `_handleReminderIntercept(ctx)`:
   ```javascript
   const occurrences = occurrenceRepository.findTodayOccurrences
     ? await occurrenceRepository.findTodayOccurrences(userId)
     : [];
   ```
3. **The Trap**: If `occurrences` has 0 records (e.g., patient hasn't generated occurrences today or cron hasn't executed), lines 1509-1545 execute:
   ```javascript
   if (!occurrences || occurrences.length === 0) {
     const allMeds = await medicationRepository.findAll(userId);
     ...
     replyText =
       `**${labels.title}**\n` +
       `- **${labels.total}:** ${activeMeds.length}\n\n` +
       medLines.join("\n");
   }
   ```
   It queries `medicationRepository.findAll(userId)` and returns:
   `"Today's Schedule: 1. Medicine A 500mg, 2. Medicine B..."`
   Instead of saying _"You have no missed doses recorded for today."_, it dumps the full medication list!
4. **The Second Flaw**: Even if occurrences _are_ found, `_handleReminderIntercept` lumps all occurrences together into a single list:
   ```javascript
   const scheduleLines = occurrences.map(
     (o) => `... ${o.medicationName} at ${timeStr} - [${o.status}]`,
   );
   ```
   It does not answer the user's specific question (_"Did I miss any...?"_), but displays all doses regardless of status.

### Path B: If Bypassing Intercepts into `ragContext.service.js`

1. If the question bypasses intercepts, `detectContextGraph` inspects `userQuestion`:
   - It matches `"medicine"` in `keywordDictionary.MEDICATION` -> adds `MEDICATIONS`.
   - It matches `"today"` or reminder words -> adds `REMINDERS`.
2. `buildDependencyAwareContext` builds:
   - `=== ACTIVE PROFILE MEDICATIONS & REFILL DETAILS ===` (with all active medications).
   - `=== MEDICATION REMINDERS STATUS TODAY ===`.
3. Injected into the prompt, the generic LLM sees the prominent medication list and answers with the daily medications.

---

## 4. Multilingual Translation Gateway Architecture

### The Problem

When a user asks:

- Hindi: _"क्या मैंने आज कोई दवा मिस की है?"_
- Gujarati: _"શું મેં આજે કોઈ દવા ચૂકી છે?"_
- Marathi: _"मी आज कोणते औषध चुकवले?"_
- Tamil: _"இன்று நான் ஏதாவது மருந்தை தவறவிட்டேனா?"_

The existing English keywords (`"today"`, `"medicine"`, `"missed"`) in `lowerQuestion` fail to match, causing the system to fall through to `GENERAL` health queries, or misclassifying the intent entirely.

### The Solution: Early Translation Gateway

1. Detect input language in `_resolveLanguage(ctx)` using `aiClient.detectLanguage(question)`.
2. In `_resolveQuestion(ctx)`, if `detectedLanguage !== "en" && detectedLanguage !== "english"`:
   - Call `aiClient.translate(question, detectedLanguage, "en")`.
   - Store result in `ctx.englishQuestion`.
   - Normalize `ctx.englishQuestion` to `ctx.retrievalQuery` and `ctx.cleanQuestion`.
3. Downstream regex, keywords, and intent classification run against `ctx.englishQuestion`.
4. Original `ctx.question` remains untouched for user-facing chat session history.
5. Final LLM prompt instructs native answering in `ctx.detectedLanguage` (or translates final response).

---

## 5. End-to-End Tracing Architecture (DEBUG-01 & DEBUG-02)

To satisfy `DEBUG-01` and `DEBUG-02`, we introduce structured lifecycle logging:

```javascript
debugLogger.info("CHAT_LIFECYCLE_TRACE", {
  step: 1, // 1 to 10
  stage: "INTENT_AND_OCCURRENCE_EVALUATION",
  userId,
  originalQuestion: ctx.question,
  detectedLanguage: ctx.detectedLanguage,
  englishQuestion: ctx.englishQuestion,
  detectedDomains: Array.from(ctx.domains || []),
  detectedIntents: ctx.intents || [],
  selectedContext: ctx.selectedContextTypes,
  dbQueryResult: {
    medicationsCount: (medications || []).length,
    todayOccurrencesCount: (todayOccurrences || []).length,
    takenCount: taken.length,
    missedCount: missed.length,
    pendingCount: pending.length,
  },
  aiPromptLength: prompt?.length,
  finalResponsePreview: response?.substring(0, 150),
});
```

---

## 6. Validation Architecture

### Verification Strategy

- **Unit Test**: `tests/unit/chatPipelineTracing.test.js`
  - Verifies that `_resolveLanguage` detects non-English queries (`hi`, `gu`, `mr`, `ta`).
  - Verifies that `_resolveQuestion` populates `ctx.englishQuestion`.
  - Verifies that trace logging is called for each stage.
  - Verifies the diagnosis test for _"Did I miss any medicine today?"_.
