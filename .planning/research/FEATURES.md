# Feature Research: Omni-Domain Multilingual Chatbot

**Domain:** Multi-Domain Conversational Health Assistant
**Researched:** 2026-09-22
**Confidence:** HIGH

## Feature Landscape

### Supported Domains & Sample Intents

| Domain                    | Core User Intents                                                                      | Supported Question Examples (Multi-language)                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User Profile**          | Name, age, DOB, blood group, allergies, login type, patient code, email, phone         | - "What is my age and blood group?"<br>- "मेरी उम्र क्या है?" (Hindi)<br>- "મારી ઉંમર કેટલી છે?" (Gujarati)<br>- "माझे वय काय आहे?" (Marathi)<br>- "என் வயது என்ன?" (Tamil)                                                                                                                     |
| **Documents & Reports**   | Uploaded documents, recent lab tests, report summaries, doctor names, document status  | - "Show me my recent medical reports."<br>- "What reports have I uploaded?"<br>- "મારા તાજેતરના રિપોર્ટ્સ બતાવો" (Gujarati)<br>- "मेरी हाल की रिपोर्ट्स दिखाएं" (Hindi)<br>- "माझे वैद्यकीय अहवाल दाखवा" (Marathi)<br>- "எனது சமீபத்திய மருத்துவ அறிக்கைகளைக் காட்டு" (Tamil)                   |
| **Medications**           | Prescriptions, drug names, dosage, intake frequency, food instructions, ongoing status | - "What medicines am I taking?"<br>- "Am I on any blood pressure medicine?"<br>- "હું કઈ દવાઓ લઈ રહ્યો છું?" (Gujarati)<br>- "मैं कौन सी दवाएं ले रहा हूँ?" (Hindi)<br>- "मी कोणती औषधे घेत आहे?" (Marathi)<br>- "நான் என்ன மருந்துகளை எடுத்துக்கொள்கிறேன்?" (Tamil)                            |
| **Reminders & Schedules** | Upcoming dosage times, today's schedule, alarm times                                   | - "When is my next medicine?"<br>- "What is my medicine schedule today?"<br>- "મારી દવા ક્યારે લેવાની છે?" (Gujarati)<br>- "मेरी अगली दवाई कब है?" (Hindi)<br>- "माझे पुढचे औषध कधी आहे?" (Marathi)<br>- "என் அடுத்த மருந்து எப்போது?" (Tamil)                                                  |
| **Dosage Occurrences**    | Missed doses, taken doses, pending doses today                                         | - "Did I miss any medicine today?"<br>- "Have I taken my morning dose?"<br>- "શું મેં આજે કોઈ દવા ચૂકી દીધી?" (Gujarati)<br>- "क्या मेरी आज कोई दवा छूट गई?" (Hindi)<br>- "मी आज कोणते औषध चुकवले का?" (Marathi)<br>- "இன்று நான் ஏதேனும் மருந்தை தவறவிட்டேனா?" (Tamil)                         |
| **Refills & Stock**       | Remaining quantity, refill warnings, days of supply left                               | - "When should I refill my medicine?"<br>- "How many pills do I have left?"<br>- "મારી દવાનો સ્ટોક કેટલો બાકી છે?" (Gujarati)<br>- "मुझे अपनी दवा कब रिफिल करनी चाहिए?" (Hindi)<br>- "माझी औषधे कधी पुन्हा भरली पाहिजेत?" (Marathi)<br>- "நான் எப்போது மருந்தை ரீஃபில் செய்ய வேண்டும்?" (Tamil) |
| **Notifications**         | Unread alerts, system announcements, medication push notices                           | - "What notifications do I have?"<br>- "Do I have any unread alerts?"<br>- "મારી પાસે કઈ નોટિફિકેશન છે?" (Gujarati)<br>- "मेरे पास क्या नोटिफिकेशन हैं?" (Hindi)<br>- "माझ्याकडे कोणत्या सूचना आहेत?" (Marathi)<br>- "எனக்கு என்ன அறிவிப்புகள் உள்ளன?" (Tamil)                                  |

### Multi-Domain Scenarios (Cross-Cutting Queries)

Users naturally combine multiple domains into single queries. The system must recognize all involved domains and pull composite context:

1. **Document Context + Medication Context:**
   - Query: _"Based on my latest report, which medicines am I currently taking?"_
   - Requires: `DOCUMENTS` (latest report diagnosis/prescription) + `MEDICATIONS` (active profile medications).
2. **Medication Context + Refill Context + Occurrence Context:**
   - Query: _"Which medicines do I need to refill soon and when are my next doses?"_
   - Requires: `MEDICATIONS` + `REFILLS` (low stock calculation) + `REMINDERS`/`OCCURRENCES` (next dosage time).
3. **Profile Context + Medication Context:**
   - Query: _"Do any of my current medications conflict with my documented allergies?"_
   - Requires: `PROFILE` (allergies array) + `MEDICATIONS` (active drug names and ingredients).
4. **Document Context + Refill Context:**
   - Query: _"How many tablets are left for the medicine prescribed in my cardiology report?"_
   - Requires: `DOCUMENTS` (find prescribed medicine name) + `MEDICATIONS` & `REFILLS` (match name and stock).

## Non-Functional Guarantees

1. **Zero Hallucination Guarantee:**
   - If a user has 0 medications, the bot must reply: _"You do not have any active medications registered."_ It must NEVER fabricate drug names.
   - If a user has not entered a Date of Birth, it must reply that Date of Birth is not configured in the profile.
2. **Language Parity:**
   - All 5 languages (English, Hindi, Gujarati, Marathi, Tamil) must produce equivalent factual accuracy.
3. **Backward Compatibility:**
   - Existing document-specific RAG queries (e.g. asking specific questions about an uploaded PDF with `documentId`) must maintain exact existing citation and relevance behavior.

---

_Feature research for: Omni-Domain Multilingual Chatbot_
_Researched: 2026-09-22_
