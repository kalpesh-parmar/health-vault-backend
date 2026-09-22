# Stack Research: Chatbot Integration Components

**Domain:** Multilingual Healthcare Chatbot
**Researched:** 2026-09-22
**Confidence:** HIGH

## Technology Components & Existing Assets

### 1. Language Detection & Translation Stack

| Component               | Technology                          | File / Endpoint                                                                                                                                                   | Role in Chatbot                                                                                                                 |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Language Detector**   | FastText / GlotLID                  | `ai-service/app/api/v1/routes/language.py` (`POST /api/v1/language/detect`) called by `src/clients/aiServiceClient.js:detectLanguage`                             | Detects language code (`en`, `hi`, `gu`, `mr`, `ta`) from user input text.                                                      |
| **Translation Engine**  | IndicTrans2 / Google GenAI fallback | `ai-service/app/api/v1/routes/translation.py` (`POST /api/v1/translate`) called by `src/clients/aiServiceClient.js:translate` and `aiClient.service.js:translate` | Translates vernacular Indian languages to English for reasoning and translates English AI replies back to user language.        |
| **Language Normalizer** | Custom RegEx & Mapping              | `src/utils/commonUtils.js:normalizeLanguage`                                                                                                                      | Maps language names and ISO codes (`hi` -> `hindi`, `gu` -> `gujarati`, `mr` -> `marathi`, `ta` -> `tamil`, `en` -> `english`). |

### 2. Domain Data Repositories

| Domain            | Repository                                                   | Key Query Methods                                           | Data Provided                                                                                |
| ----------------- | ------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Profile**       | `src/repositories/patientRepository.js`                      | `findById(userId)`                                          | Name, DOB, gender, blood group, allergies, patient code, email, mobile, verification status. |
| **Auth**          | `src/repositories/authProviderRepository.js`                 | `findByUserId(userId)`                                      | Linked social accounts (Google, Microsoft, Facebook, Apple).                                 |
| **Medications**   | `src/repositories/medicationRepository.js`                   | `findAll(userId)`                                           | Prescription name, dosage, frequency, food instruction, ongoing status, schedules.           |
| **Occurrences**   | `src/repositories/medicationReminderOccurrenceRepository.js` | `findOccurrencesByUserIdAndDateRange(userId, start, end)`   | Dose statuses (`PENDING`, `TAKEN`, `SKIPPED`, `MISSED`), timestamps.                         |
| **Reminders**     | `src/repositories/medicationReminderRepository.js`           | `findAllByUserId(userId)`                                   | Scheduled reminder times, alert settings.                                                    |
| **Refills**       | `src/repositories/refillRepository.js`                       | `findLatestRefillByMedicationId(medId)`                     | Total quantity, remaining quantity, refill history, stock alerts.                            |
| **Documents**     | `src/repositories/documentRepository.js`                     | `getSummaryByUserId(userId)`, `findRecentDocuments(userId)` | Uploaded reports, hospital names, doctor names, diagnoses, report dates.                     |
| **Notifications** | `src/repositories/notificationRepository.js`                 | `list({ userId, sort })`                                    | System notifications, reminder alerts, read/unread status.                                   |

### 3. Context Builder & LLM Inference

| Component                     | File                                             | Responsibilities                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Universal Context Builder** | `src/services/ai/chat/ragContext.service.js`     | Assembles domain blocks into structured, grounded text (`buildDependencyAwareContext`).                                                                               |
| **LLM Inference Client**      | `src/clients/ollamaClient.js` / Google GenAI SDK | Executes Qwen/Gemini conversational inference with strict prompt boundaries.                                                                                          |
| **Response Dictionary**       | `src/constants/chatReplies.js`                   | Pre-localized templates for deterministic intercepts (`AGE_REPLY_I18N`, `PROFILE_REPLY_I18N`, `REMINDER_REPLY_I18N`, `REFILL_REPLY_I18N`, `NOTIFICATION_REPLY_I18N`). |

---

_Stack research for: Multilingual Healthcare Chatbot_
_Researched: 2026-09-22_
