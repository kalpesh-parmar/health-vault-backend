const keywordDictionary = require("../../../constants/keywordDictionary");
const { normalizeToDateOnly } = require("../../../utils/dateUtils");
const { hasAny } = require("./chatHelpers");
const {
  SPECIFIC_PROFILE_FIELDS,
  COUNT_KEYWORDS,
  LIST_KEYWORDS,
  CLINICAL_ADVICE_KEYWORDS,
  TEMPORAL_INDICATORS,
} = keywordDictionary;

class ChatClassifierService {
  /**
   * Classifies query intent, domains, and entities.
   *
   * @param {object} params
   * @param {string} params.rawQuestion - User's original question
   * @param {string} params.englishQuestion - Translated / normalized English question
   * @param {string} params.detectedLanguage - Detected language (en, gu, hi, mr, ta)
   * @param {Array<string>} [params.documentId] - Optional explicit document IDs
   * @returns {object} Classification report
   */
  classify({
    rawQuestion = "",
    englishQuestion = "",
    question = "",
    detectedLanguage = "english",
    documentId = [],
  }) {
    const rawQ = String(rawQuestion || question || "").trim();
    const engQ = String(englishQuestion || question || rawQuestion || "").trim();

    const lowerRaw = rawQ.toLowerCase();
    const lowerEng = engQ.toLowerCase();
    const cleanEng = lowerEng.replace(/[?.,!]/g, "").trim();
    const cleanRaw = lowerRaw.replace(/[?.,!]/g, "").trim();

    const domains = new Set();
    const intents = new Set();

    // 1. Clinical Advice & Reasoning Check
    const isClinicalAdvice =
      hasAny(lowerEng, CLINICAL_ADVICE_KEYWORDS) || hasAny(lowerRaw, CLINICAL_ADVICE_KEYWORDS);
    if (isClinicalAdvice) {
      intents.add("CLINICAL_ADVICE");
    }

    // 2. Document Content Biomarker / Medical Entity Check
    const contentBiomarkerKeywords = keywordDictionary.DOCUMENT_CONTENT_BIOMARKER || [];
    const hasBiomarkerSearch =
      hasAny(lowerEng, contentBiomarkerKeywords) || hasAny(lowerRaw, contentBiomarkerKeywords);

    // 3. Document Comparison & Summary Checks
    const compareKeywords = keywordDictionary.COMPARE || [];
    const summaryKeywords = keywordDictionary.SUMMARY || [];
    const hasExplicitCompare =
      hasAny(lowerEng, compareKeywords) || hasAny(lowerRaw, compareKeywords);
    const hasSummaryRequest =
      hasAny(lowerEng, summaryKeywords) || hasAny(lowerRaw, summaryKeywords);

    // 4. Temporal Entity Extraction
    let temporal = null;
    let targetDate = null;
    const now = new Date();

    const hasTemporalWord = (text, list) => {
      if (!text || !Array.isArray(list)) return false;
      const tokens = text.split(/[\s,?.!]+/);
      return list.some((kw) => {
        if (kw.length <= 4) {
          return tokens.includes(kw);
        }
        return text.includes(kw);
      });
    };

    if (
      hasTemporalWord(lowerEng, TEMPORAL_INDICATORS.today) ||
      hasTemporalWord(lowerRaw, TEMPORAL_INDICATORS.today)
    ) {
      temporal = "today";
      targetDate = normalizeToDateOnly(now);
      intents.add("TEMPORAL");
    } else if (
      hasTemporalWord(lowerEng, TEMPORAL_INDICATORS.yesterday) ||
      hasTemporalWord(lowerRaw, TEMPORAL_INDICATORS.yesterday)
    ) {
      temporal = "yesterday";
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      targetDate = normalizeToDateOnly(yesterday);
      intents.add("TEMPORAL");
    } else if (
      hasTemporalWord(lowerEng, TEMPORAL_INDICATORS.tomorrow) ||
      hasTemporalWord(lowerRaw, TEMPORAL_INDICATORS.tomorrow)
    ) {
      temporal = "tomorrow";
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      targetDate = normalizeToDateOnly(tomorrow);
      intents.add("TEMPORAL");
    } else if (
      hasTemporalWord(lowerEng, TEMPORAL_INDICATORS.next) ||
      hasTemporalWord(lowerRaw, TEMPORAL_INDICATORS.next)
    ) {
      temporal = "next";
      intents.add("TEMPORAL");
    }

    // 5. Query Shape: Count vs. List
    const isCountQuery = hasAny(lowerEng, COUNT_KEYWORDS) || hasAny(lowerRaw, COUNT_KEYWORDS);
    const isListQuery = hasAny(lowerEng, LIST_KEYWORDS) || hasAny(lowerRaw, LIST_KEYWORDS);

    if (isCountQuery) intents.add("COUNT");
    if (isListQuery) intents.add("LIST");

    // 6. Profile Domain & Specific Field Extraction
    const isProfileExcluded = hasAny(lowerEng, keywordDictionary.PROFILE_EXCLUSIONS || []);
    let detectedProfileField = null;

    if (!isProfileExcluded) {
      for (const [fieldName, keywords] of Object.entries(SPECIFIC_PROFILE_FIELDS)) {
        const matchesField = keywords.some((kw) => {
          if (/^[a-zA-Z\s]+$/.test(kw)) {
            const regex = new RegExp(`\\b${kw}\\b`, "i");
            return regex.test(lowerEng);
          }
          return lowerEng.includes(kw) || lowerRaw.includes(kw);
        });
        if (matchesField) {
          detectedProfileField = fieldName;
          domains.add("PROFILE");
          intents.add(fieldName === "fullProfile" ? "STATUS" : "SPECIFIC_FIELD");
          break;
        }
      }

      const matchesProfile = (keywordDictionary.PROFILE || []).some((kw) => {
        if (/^[a-zA-Z\s]+$/.test(kw)) {
          const regex = new RegExp(`\\b${kw}\\b`, "i");
          return regex.test(lowerEng);
        }
        return lowerEng.includes(kw) || lowerRaw.includes(kw);
      });

      if (!detectedProfileField && matchesProfile) {
        domains.add("PROFILE");
      }
    }

    // 7. Domain Detection: Reminders, Refills, Notifications, Medications, Documents
    const reminderKeywords = keywordDictionary.REMINDER || [];
    const refillKeywords = keywordDictionary.REFILL || [];
    const notifKeywords = keywordDictionary.NOTIFICATION || [];
    const medKeywords = keywordDictionary.MEDICATION || [];
    const medListKeywords = keywordDictionary.MEDICATION_LIST || [];
    const docKeywords = keywordDictionary.DOCUMENT || [];
    const docListKeywords = keywordDictionary.DOCUMENT_LIST || [];

    const isPureDoseInfo =
      lowerEng.includes("dose of") ||
      lowerEng.includes("the dose") ||
      lowerEng.includes("what dose") ||
      lowerEng.includes("what dosage") ||
      lowerEng.includes("dosage") ||
      lowerRaw.includes("કેટલો ડોઝ") ||
      lowerRaw.includes("કેટલી માત્રા") ||
      lowerRaw.includes("कितना डोज़") ||
      lowerRaw.includes("कितनी मात्रा");

    const hasReminderWord =
      !isPureDoseInfo && (hasAny(lowerEng, reminderKeywords) || hasAny(lowerRaw, reminderKeywords));
    const hasRefillWord = hasAny(lowerEng, refillKeywords) || hasAny(lowerRaw, refillKeywords);
    const hasNotifWord =
      hasAny(lowerEng, notifKeywords) ||
      hasAny(lowerRaw, notifKeywords) ||
      lowerEng.includes("unread suggestions");
    const hasMedWord =
      hasAny(lowerEng, medKeywords) ||
      hasAny(lowerRaw, medKeywords) ||
      hasAny(lowerEng, medListKeywords) ||
      hasAny(lowerRaw, medListKeywords) ||
      lowerEng.includes("dosage") ||
      lowerEng.includes("dose") ||
      lowerRaw.includes("ડોઝ") ||
      lowerRaw.includes("ખુરાક") ||
      lowerRaw.includes("खुराक") ||
      lowerRaw.includes("मात्रा") ||
      lowerRaw.includes("डोस") ||
      lowerRaw.includes("மருந்தளவு") ||
      lowerEng.includes("before food") ||
      lowerEng.includes("after food") ||
      lowerRaw.includes("જમતા પહેલા") ||
      lowerRaw.includes("જમ્યા પછી") ||
      lowerRaw.includes("ખાધા પછી") ||
      lowerRaw.includes("खाने से पहले") ||
      lowerRaw.includes("खाने के बाद") ||
      lowerRaw.includes("जेवणापूर्वी") ||
      lowerRaw.includes("जेवणानंतर") ||
      lowerRaw.includes("உணவுக்கு முன்") ||
      lowerRaw.includes("உணவுக்குப் பின்");
    const docQueryEng = lowerEng.replace(/\bprofile(s)?\b/g, "").trim();
    const docQueryRaw = lowerRaw
      .replace(/\bprofile(s)?\b/g, "")
      .replace(/પ્રોફાઇલ|પ્રોફાઈલ|प्रोफाइल|சுயவிவரம்/g, "")
      .trim();

    const hasDocWord =
      hasAny(docQueryEng, docKeywords) ||
      hasAny(docQueryRaw, docKeywords) ||
      hasAny(docQueryEng, docListKeywords) ||
      hasAny(docQueryRaw, docListKeywords);

    // Dose status keywords (missed, taken, pending)
    const hasDoseStatus =
      lowerEng.includes("missed") ||
      lowerEng.includes("miss ") ||
      lowerEng.includes("taken") ||
      lowerEng.includes("pending") ||
      lowerEng.includes("skipped") ||
      lowerEng.includes("skip ") ||
      lowerEng.includes("overdue") ||
      lowerRaw.includes("ચૂકી") ||
      lowerRaw.includes("લીધી") ||
      lowerRaw.includes("छूट") ||
      lowerRaw.includes("चुकले") ||
      lowerRaw.includes("घेतले") ||
      lowerRaw.includes("தவறியது") ||
      lowerRaw.includes("எடுத்தது");

    if (hasMedWord) {
      domains.add("MEDICATIONS");
    }

    const hasNeedToTakeCheck =
      !isCountQuery &&
      (lowerEng.includes("need to take") ||
        lowerEng.includes("have to take") ||
        lowerRaw.includes("લેવાની") ||
        lowerRaw.includes("લેવાનું") ||
        lowerRaw.includes("लेनी") ||
        lowerRaw.includes("लेना") ||
        lowerRaw.includes("घ्यायची") ||
        lowerRaw.includes("घ्यायचे") ||
        lowerRaw.includes("வேண்டும்"));

    if (hasReminderWord || (hasMedWord && (temporal || hasDoseStatus)) || hasNeedToTakeCheck) {
      domains.add("REMINDERS");
      intents.add("STATUS");
    }

    if (
      hasRefillWord ||
      (hasMedWord && (lowerEng.includes("stock") || lowerEng.includes("remaining")))
    ) {
      domains.add("REFILLS");
      domains.add("MEDICATIONS");
      intents.add("STATUS");
    }

    if (hasNotifWord) {
      domains.add("NOTIFICATIONS");
      intents.add("STATUS");
    }

    if (
      hasDocWord ||
      hasBiomarkerSearch ||
      hasExplicitCompare ||
      (documentId && documentId.length > 0)
    ) {
      domains.add("DOCUMENTS");
    }

    // Overview / Global Catch-All
    const overviewKeywords = keywordDictionary.OVERVIEW || [];
    const hasOverview = hasAny(lowerEng, overviewKeywords) || hasAny(lowerRaw, overviewKeywords);
    if ((domains.size === 0 || hasOverview) && !detectedProfileField) {
      domains.add("PROFILE");
      domains.add("MEDICATIONS");
      domains.add("REMINDERS");
      domains.add("REFILLS");
      domains.add("DOCUMENTS");
    }

    // 8. Document RAG vs. Catalog Decision
    const requiresRag =
      hasBiomarkerSearch ||
      hasExplicitCompare ||
      (documentId && documentId.length > 0 && !isListQuery && !isCountQuery) ||
      (domains.has("DOCUMENTS") &&
        isClinicalAdvice &&
        !isListQuery &&
        !isCountQuery &&
        !hasSummaryRequest);

    // 9. Status and Type Filters for Documents
    let statusFilter = null;
    if (lowerEng.includes("failed") || lowerEng.includes("reject")) {
      statusFilter = "FAILED";
    } else if (lowerEng.includes("completed") || lowerEng.includes("success")) {
      statusFilter = "COMPLETED";
    } else if (lowerEng.includes("pending") || lowerEng.includes("processing")) {
      statusFilter = "PENDING";
    }

    let typeFilter = null;
    if (
      lowerEng.includes("lab") ||
      lowerEng.includes("blood test") ||
      lowerRaw.includes("લેબ") ||
      lowerRaw.includes("લેબોરેટરી") ||
      lowerRaw.includes("लैब") ||
      lowerRaw.includes("प्रयोगशाळा") ||
      lowerRaw.includes("ஆய்வக")
    ) {
      typeFilter = "lab_report";
    } else if (
      lowerEng.includes("prescription") ||
      lowerRaw.includes("પ્રિસ્ક્રિપ્શન") ||
      lowerRaw.includes("प्रिस्क्रिप्शन") ||
      lowerRaw.includes("नुस्खा") ||
      lowerRaw.includes("மருந்துச்சீட்டு")
    ) {
      typeFilter = "prescription";
    } else if (
      lowerEng.includes("x-ray") ||
      lowerEng.includes("mri") ||
      lowerEng.includes("scan") ||
      lowerEng.includes("radiology") ||
      lowerRaw.includes("એક્સ-રે") ||
      lowerRaw.includes("एक्स-रे") ||
      lowerRaw.includes("स्कॅन") ||
      lowerRaw.includes("ஸ்கேன்")
    ) {
      typeFilter = "radiology";
    }

    // 10. Notification specific filter: Unread only
    const isUnreadOnly =
      lowerEng.includes("unread") ||
      lowerRaw.includes("ન વંચાયેલ") ||
      lowerRaw.includes("अपठित") ||
      lowerRaw.includes("न वाचलेले") ||
      lowerRaw.includes("படிக்காத");

    // 10b. Medication Facet Extraction (timing, food, status, dosage, schedule)
    let medicationFacet = null;
    if (domains.has("MEDICATIONS")) {
      const isMorning =
        lowerEng.includes("morning") ||
        lowerEng.includes("breakfast") ||
        lowerRaw.includes("સવારે") ||
        lowerRaw.includes("સવાર") ||
        lowerRaw.includes("सुबह") ||
        lowerRaw.includes("सकाळी") ||
        lowerRaw.includes("காலை");

      const isNight =
        lowerEng.includes("night") ||
        lowerEng.includes("bedtime") ||
        lowerEng.includes("dinner") ||
        lowerEng.includes("evening") ||
        lowerRaw.includes("રાત્રે") ||
        lowerRaw.includes("રાત") ||
        lowerRaw.includes("रात") ||
        lowerRaw.includes("रात्री") ||
        lowerRaw.includes("இரவு");

      const isBeforeFood =
        lowerEng.includes("before food") ||
        lowerEng.includes("before meal") ||
        lowerEng.includes("empty stomach") ||
        lowerRaw.includes("ભૂખ્યા પેટે") ||
        lowerRaw.includes("જમતા પહેલા") ||
        lowerRaw.includes("ખાતા પહેલા") ||
        lowerRaw.includes("खाली पेट") ||
        lowerRaw.includes("खाने से पहले") ||
        lowerRaw.includes("जेवणापूर्वी") ||
        lowerRaw.includes("உணவுக்கு முன்");

      const isAfterFood =
        lowerEng.includes("after food") ||
        lowerEng.includes("after meal") ||
        lowerRaw.includes("જમ્યા પછી") ||
        lowerRaw.includes("ખાધા પછી") ||
        lowerRaw.includes("खाने के बाद") ||
        lowerRaw.includes("जेवणानंतर") ||
        lowerRaw.includes("உணவுக்குப் பின்");

      const isInactive =
        lowerEng.includes("inactive") ||
        lowerEng.includes("stopped") ||
        lowerEng.includes("completed") ||
        lowerEng.includes("past medication") ||
        lowerEng.includes("finished") ||
        lowerEng.includes("out of stock") ||
        lowerEng.includes("no stock") ||
        lowerEng.includes("zero stock") ||
        lowerEng.includes("stock completed") ||
        lowerEng.includes("over") ||
        lowerRaw.includes("બંધ") ||
        lowerRaw.includes("નિષ્ક્રિય") ||
        lowerRaw.includes("પૂરી") ||
        lowerRaw.includes("પુરી") ||
        lowerRaw.includes("પૂરી થયેલી") ||
        lowerRaw.includes("સ્ટોક પૂરો") ||
        lowerRaw.includes("સ્ટોક ખતમ") ||
        lowerRaw.includes("ખતમ") ||
        lowerRaw.includes("પતી ગઈ") ||
        lowerRaw.includes("નિષ્ક્રીય") ||
        lowerRaw.includes("પોતાની પૂરી થયેલી") ||
        lowerRaw.includes("ખૂટી ગઈ") ||
        lowerRaw.includes("જથ્થો પૂરો") ||
        lowerRaw.includes("જથ્થો ખતમ") ||
        lowerRaw.includes("શૂન્ય સ્ટોક") ||
        lowerRaw.includes("જથ્થો 0") ||
        lowerRaw.includes("માત્રા 0") ||
        lowerRaw.includes("ખતમ થઈ ગયેલી") ||
        lowerRaw.includes("પૂરી થઈ ગઈ") ||
        lowerRaw.includes("પૂરી થઈ ગઈ છે") ||
        lowerRaw.includes("निष्क्रिय") ||
        lowerRaw.includes("बंद") ||
        lowerRaw.includes("पूरी हुई") ||
        lowerRaw.includes("समाप्त") ||
        lowerRaw.includes("खत्म") ||
        lowerRaw.includes("स्टॉक खत्म") ||
        lowerRaw.includes("पूरी हो गई") ||
        lowerRaw.includes("मात्रा 0") ||
        lowerRaw.includes("शून्य स्टॉक") ||
        lowerRaw.includes("थांबवलेले") ||
        lowerRaw.includes("संपलेली") ||
        lowerRaw.includes("साठा संपला") ||
        lowerRaw.includes("पूर्ण") ||
        lowerRaw.includes("પૂર્ણ") ||
        lowerRaw.includes("છેલ્લા") ||
        lowerRaw.includes("પૂર્ણ થયેલી") ||
        lowerRaw.includes("પૂર્ણ થયેલ") ||
        lowerRaw.includes("પૂર્ણ થયેલ દવાઓ") ||
        lowerRaw.includes("પૂર્ણ થયેલી દવાઓ") ||
        lowerRaw.includes("પૂર્ણ થયેલી દવાની યાદી") ||
        lowerRaw.includes("પોતાની પૂરી થયેલી દવાઓ") ||
        lowerRaw.includes("ચૂકી ગયેલી") ||
        lowerRaw.includes("સાઠો 0") ||
        lowerRaw.includes("செயலற்ற") ||
        lowerRaw.includes("முடிந்த") ||
        lowerRaw.includes("முடிந்தது") ||
        lowerRaw.includes("இருப்பு முடிந்தது") ||
        lowerRaw.includes("அளவு 0") ||
        lowerRaw.includes("முடிந்துவிட்டது");

      const isActive =
        !isInactive &&
        (lowerEng.includes("active") ||
          lowerEng.includes("currently taking") ||
          lowerEng.includes("current medication") ||
          lowerRaw.includes("ચાલુ") ||
          lowerRaw.includes("સક્રિય") ||
          lowerRaw.includes("सक्रिय") ||
          lowerRaw.includes("चालू") ||
          lowerRaw.includes("செயலில்"));

      const isDosage =
        lowerEng.includes("dosage") ||
        lowerEng.includes("dose") ||
        lowerRaw.includes("ડોઝ") ||
        lowerRaw.includes("ખુરાક") ||
        lowerRaw.includes("खुराक") ||
        lowerRaw.includes("मात्रा") ||
        lowerRaw.includes("डोस") ||
        lowerRaw.includes("மருந்தளவு");

      const isWhenToTake =
        lowerEng.includes("when should i take") ||
        lowerEng.includes("when to take") ||
        (lowerEng.includes("when") &&
          (lowerEng.includes("medicine") || lowerEng.includes("medication"))) ||
        lowerEng.includes("timing") ||
        lowerEng.includes("schedule") ||
        lowerRaw.includes("ક્યારે લેવી") ||
        lowerRaw.includes("ક્યારે લેવાની") ||
        lowerRaw.includes("સમય") ||
        lowerRaw.includes("कब लेनी है") ||
        lowerRaw.includes("कधी घ्यायची") ||
        lowerRaw.includes("எப்போது உட்கொள்ள வேண்டும்");

      if (isMorning) {
        medicationFacet = { type: "timing", value: "morning" };
      } else if (isNight) {
        medicationFacet = { type: "timing", value: "night" };
      } else if (isBeforeFood) {
        medicationFacet = { type: "food", value: "before_food" };
      } else if (isAfterFood) {
        medicationFacet = { type: "food", value: "after_food" };
      } else if (isInactive) {
        medicationFacet = { type: "status", value: "inactive" };
      } else if (isActive) {
        medicationFacet = { type: "status", value: "active" };
      } else if (isDosage) {
        medicationFacet = { type: "info", value: "dosage" };
      } else if (isWhenToTake) {
        medicationFacet = { type: "info", value: "when_to_take" };
      } else if (
        isListQuery ||
        lowerEng.includes("current") ||
        lowerEng.includes("what medicine") ||
        lowerEng.includes("what medicines") ||
        lowerEng.includes("medicines am i taking") ||
        lowerEng.includes("show all") ||
        lowerRaw.includes("કઈ દવા") ||
        lowerRaw.includes("કઈ દવાઓ") ||
        lowerRaw.includes("બધી દવાઓ") ||
        lowerRaw.includes("कौन सी दवा") ||
        lowerRaw.includes("कोणती औषधे") ||
        lowerRaw.includes("என்ன மருந்துகள்")
      ) {
        medicationFacet = { type: "list", value: "all" };
      }
    }

    if (temporal) {
      medicationFacet = null;
    }

    if (medicationFacet) {
      domains.add("MEDICATIONS");
      const hasExplicitReminder =
        lowerEng.includes("reminder") ||
        lowerRaw.includes("રિમાઇન્ડર") ||
        lowerRaw.includes("रिमाइंडर") ||
        lowerRaw.includes("स्मरणपत्र") ||
        lowerRaw.includes("நினைவூட்டல்") ||
        hasDoseStatus ||
        temporal ||
        lowerEng.includes("next");
      if (!hasExplicitReminder) {
        domains.delete("REMINDERS");
      }
    }

    // 10c. Reminder Facet Extraction (missed, overdue, next, specific_time, need_to_take, tomorrow, today, all)
    let reminderFacet = null;
    if (domains.has("REMINDERS")) {
      const isMissed =
        lowerEng.includes("missed") ||
        lowerEng.includes("miss ") ||
        lowerEng.includes("did i miss") ||
        lowerRaw.includes("ચૂકી") ||
        lowerRaw.includes("છૂટી") ||
        lowerRaw.includes("छूट") ||
        lowerRaw.includes("चुकले") ||
        lowerRaw.includes("தவறிய");

      const isOverdue =
        !isMissed &&
        (lowerEng.includes("overdue") ||
          lowerRaw.includes("ઓવરડ્યુ") ||
          lowerRaw.includes("अतिदेय") ||
          lowerRaw.includes("प्रलंबित") ||
          lowerRaw.includes("தாமதமான"));

      const isNext =
        lowerEng.includes("next reminder") ||
        lowerEng.includes("next dose") ||
        lowerEng.includes("next medicine") ||
        lowerEng.includes("next medication") ||
        lowerRaw.includes("આગામી") ||
        lowerRaw.includes("પછીનું") ||
        lowerRaw.includes("अगला") ||
        lowerRaw.includes("पुढील") ||
        lowerRaw.includes("அடுத்த");

      let specificTime = null;
      const rawWithNormalizedDigits = lowerRaw.replace(/[०-९]/g, (d) => "०१२३४५६७८९".indexOf(d));
      if (
        lowerEng.includes("at ") ||
        lowerEng.includes("reminder at") ||
        lowerRaw.includes("વાગ્યે") ||
        lowerRaw.includes("બજે") ||
        lowerRaw.includes("बजे") ||
        lowerRaw.includes("वाजता") ||
        lowerRaw.includes("மணிக்கு")
      ) {
        const timeMatch =
          lowerEng.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i) ||
          lowerEng.match(/at\s+(\d{1,2})(?::(\d{2}))?/i) ||
          rawWithNormalizedDigits.match(
            /(\d{1,2})(?::(\d{2}))?\s*(?:વાગ્યે|બજે|बजे|वाजता|மணிக்கு)/,
          );
        if (timeMatch) {
          let h = parseInt(timeMatch[1], 10);
          const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
          const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
          if (ampm === "pm" && h < 12) h += 12;
          if (ampm === "am" && h === 12) h = 0;
          const displayH = h % 12 || 12;
          const displayAmpm = h >= 12 ? "PM" : "AM";
          const displayTime = `${displayH}:${String(m).padStart(2, "0")} ${displayAmpm}`;
          const normalized24 = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          specificTime = { hour: h, minute: m, displayTime, normalized24 };
        }
      }

      const isNeedToTake =
        lowerEng.includes("need to take") ||
        lowerEng.includes("have to take") ||
        lowerRaw.includes("લેવાની છે") ||
        lowerRaw.includes("લેવાનું છે") ||
        lowerRaw.includes("લેવાની") ||
        lowerRaw.includes("लेनी है") ||
        lowerRaw.includes("लेना है") ||
        lowerRaw.includes("घ्यायची आहे") ||
        lowerRaw.includes("घ्यायचे आहे") ||
        lowerRaw.includes("घ्यायची") ||
        lowerRaw.includes("உட்கொள்ள வேண்டும்") ||
        lowerRaw.includes("எடுத்துக்கொள்ள வேண்டும்");

      if (isMissed) {
        reminderFacet = { type: "missed" };
      } else if (isOverdue) {
        reminderFacet = { type: "overdue" };
      } else if (isNext) {
        reminderFacet = { type: "next" };
      } else if (specificTime) {
        reminderFacet = { type: "specific_time", time: specificTime };
      } else if (isNeedToTake) {
        reminderFacet = { type: "need_to_take" };
      } else if (temporal === "tomorrow") {
        reminderFacet = { type: "tomorrow" };
      } else {
        reminderFacet = { type: "all" };
      }

      // If user is asking for reminders, keep domains focused on REMINDERS unless explicitly joining both with "and"
      const hasExplicitAnd =
        lowerEng.includes(" and ") ||
        lowerRaw.includes(" અને ") ||
        lowerRaw.includes(" और ") ||
        lowerRaw.includes(" आणि ") ||
        lowerRaw.includes(" மற்றும் ");
      if (!isCountQuery && !hasExplicitAnd) {
        domains.delete("MEDICATIONS");
      }
    }

    // 10d. Refill Facet Extraction (need_refill, latest, history, count, all)
    let refillFacet = null;
    if (domains.has("REFILLS")) {
      const isNeedRefill =
        lowerEng.includes("need a refill") ||
        lowerEng.includes("need refill") ||
        lowerEng.includes("needs refill") ||
        lowerEng.includes("pending refill") ||
        lowerEng.includes("pending refills") ||
        lowerEng.includes("do i need to refill") ||
        lowerEng.includes("which need refill") ||
        lowerEng.includes("which medicines need") ||
        lowerEng.includes("which medicine need") ||
        lowerEng.includes("low stock") ||
        lowerEng.includes("running low") ||
        lowerEng.includes("run out") ||
        lowerRaw.includes("જરૂર") ||
        lowerRaw.includes("ઓછો") ||
        lowerRaw.includes("બાકી રિફિલ") ||
        lowerRaw.includes("जरूरत") ||
        lowerRaw.includes("आवश्यकता") ||
        lowerRaw.includes("आवश्यक") ||
        lowerRaw.includes("पाहिजे") ||
        lowerRaw.includes("தேவை");

      const isLatest =
        lowerEng.includes("latest refill") ||
        lowerEng.includes("recent refill") ||
        lowerEng.includes("recently refilled") ||
        lowerEng.includes("last refill") ||
        lowerEng.includes("last refill date") ||
        lowerEng.includes("when was my last") ||
        lowerRaw.includes("છેલ્લી") ||
        lowerRaw.includes("તાજેતર") ||
        lowerRaw.includes("नवीनतम") ||
        lowerRaw.includes("आखिरी") ||
        lowerRaw.includes("अंतिम") ||
        lowerRaw.includes("पिछली") ||
        lowerRaw.includes("शेवटची") ||
        lowerRaw.includes("नुकतीચ") ||
        lowerRaw.includes("नુકતીચ") ||
        lowerRaw.includes("नुकतीच") ||
        lowerRaw.includes("சமீபத்திய") ||
        lowerRaw.includes("கடைசி");

      const isHistory =
        lowerEng.includes("history") ||
        lowerEng.includes("past refill") ||
        lowerEng.includes("show my refill") ||
        lowerEng.includes("show refills") ||
        lowerEng.includes("refill history") ||
        lowerRaw.includes("ઇતિહાસ") ||
        lowerRaw.includes("ઇતિહાસ") ||
        lowerRaw.includes("इतिहास") ||
        lowerRaw.includes("வரலாறு");

      if (isCountQuery) {
        refillFacet = { type: "count" };
      } else if (isLatest) {
        refillFacet = { type: "latest" };
      } else if (isNeedRefill) {
        refillFacet = { type: "need_refill" };
      } else if (isHistory) {
        refillFacet = { type: "history" };
      } else {
        refillFacet = { type: "all" };
      }

      const hasExplicitAnd =
        lowerEng.includes(" and ") ||
        lowerRaw.includes(" અને ") ||
        lowerRaw.includes(" और ") ||
        lowerRaw.includes(" आणि ") ||
        lowerRaw.includes(" மற்றும் ");
      if (!hasExplicitAnd) {
        domains.delete("MEDICATIONS");
      }
    }

    // 10e. Document Facet Extraction (latest, type, status, count, list)
    let documentFacet = null;
    if (domains.has("DOCUMENTS")) {
      const isLatestDoc =
        lowerEng.includes("latest") ||
        lowerEng.includes("most recent") ||
        lowerEng.includes("recent") ||
        lowerEng.includes("last report") ||
        lowerEng.includes("last document") ||
        lowerRaw.includes("છેલ્લો") ||
        lowerRaw.includes("છેલ્લી") ||
        lowerRaw.includes("તાજેતર") ||
        lowerRaw.includes("नवीनतम") ||
        lowerRaw.includes("आखिरी") ||
        lowerRaw.includes("अंतिम") ||
        lowerRaw.includes("शेवटचा") ||
        lowerRaw.includes("शेवटची") ||
        lowerRaw.includes("சமீபத்திய") ||
        lowerRaw.includes("கடைசி");

      if (isCountQuery) {
        documentFacet = { type: "count" };
      } else if (isLatestDoc) {
        documentFacet = { type: "latest" };
      } else if (typeFilter) {
        documentFacet = { type: "type", filter: typeFilter };
      } else if (statusFilter) {
        documentFacet = { type: "status", filter: statusFilter };
      } else {
        documentFacet = { type: "list" };
      }
    }

    // 10f. Notification Facet Extraction (unread, latest, last, today, important, count, list)
    let notificationFacet = null;
    if (domains.has("NOTIFICATIONS")) {
      const isLastNotif =
        lowerEng.includes("last notification") ||
        lowerEng.includes("last alert") ||
        lowerEng.includes("what was my last") ||
        lowerRaw.includes("છેલ્લી નોટિફિકેશન") ||
        lowerRaw.includes("છેલ્લી સૂચના") ||
        lowerRaw.includes("आखिरी सूचना") ||
        lowerRaw.includes("अंतिम सूचना") ||
        lowerRaw.includes("शेवटची सूचना") ||
        lowerRaw.includes("கடைசி அறிவிப்பு");

      const isLatestNotif =
        lowerEng.includes("latest") ||
        lowerEng.includes("recent") ||
        lowerRaw.includes("તાજેતર") ||
        lowerRaw.includes("नवीनतम") ||
        lowerRaw.includes("नुकत्याच") ||
        lowerRaw.includes("சமீபத்திய");

      const isTodayNotif =
        temporal === "today" ||
        lowerEng.includes("today") ||
        lowerRaw.includes("આજના") ||
        lowerRaw.includes("આજે") ||
        lowerRaw.includes("आज की") ||
        lowerRaw.includes("आजच्या") ||
        lowerRaw.includes("இன்றைய");

      const isImportantNotif =
        lowerEng.includes("important") ||
        lowerEng.includes("urgent") ||
        lowerEng.includes("critical") ||
        lowerRaw.includes("મહત્વપૂર્ણ") ||
        lowerRaw.includes("જરૂરી") ||
        lowerRaw.includes("महत्वपूर्ण") ||
        lowerRaw.includes("महत्त्वाच्या") ||
        lowerRaw.includes("முக்கியமான");

      const isUnreadCount =
        isCountQuery ||
        lowerEng.includes("unread count") ||
        lowerEng.includes("notification count") ||
        (lowerEng.includes("how many") &&
          (lowerEng.includes("unread") || lowerEng.includes("notification"))) ||
        lowerRaw.includes("કેટલી ન વંચાયેલ") ||
        lowerRaw.includes("કેટલી નોટિફિકેશન") ||
        lowerRaw.includes("કુલ કેટલી નોટિફિકેશન") ||
        lowerRaw.includes("कितनी अपठित") ||
        lowerRaw.includes("कितनी सूचनाएं") ||
        lowerRaw.includes("किती न वाचलेल्या") ||
        lowerRaw.includes("எத்தனை படிக்காத");

      if (
        isUnreadCount &&
        (lowerEng.includes("count") || lowerEng.includes("how many") || isCountQuery)
      ) {
        notificationFacet = { type: "count" };
      } else if (isLastNotif) {
        notificationFacet = { type: "last" };
      } else if (isLatestNotif) {
        notificationFacet = { type: "latest" };
      } else if (isTodayNotif) {
        notificationFacet = { type: "today" };
      } else if (isImportantNotif) {
        notificationFacet = { type: "important" };
      } else if (isUnreadOnly) {
        notificationFacet = { type: "unread" };
      } else {
        notificationFacet = { type: "list" };
      }
    }

    // 11. Multi-Domain & Fast-Path Eligibility
    const hasMultipleDistinctDomains = (() => {
      // Profile combined with any other domain -> multi-domain
      if (
        domains.has("PROFILE") &&
        (domains.has("MEDICATIONS") ||
          domains.has("DOCUMENTS") ||
          domains.has("REMINDERS") ||
          domains.has("NOTIFICATIONS") ||
          domains.has("REFILLS"))
      ) {
        return true;
      }
      // Documents combined with other domains -> multi-domain
      if (
        domains.has("DOCUMENTS") &&
        (domains.has("PROFILE") ||
          domains.has("MEDICATIONS") ||
          domains.has("REMINDERS") ||
          domains.has("NOTIFICATIONS") ||
          domains.has("REFILLS"))
      ) {
        return true;
      }
      // Notifications combined with other domains -> multi-domain
      if (
        domains.has("NOTIFICATIONS") &&
        (domains.has("PROFILE") ||
          domains.has("DOCUMENTS") ||
          domains.has("REMINDERS") ||
          domains.has("MEDICATIONS") ||
          domains.has("REFILLS"))
      ) {
        return true;
      }
      // Reminders combined with other domains -> multi-domain
      if (
        domains.has("REMINDERS") &&
        (domains.has("PROFILE") ||
          domains.has("DOCUMENTS") ||
          domains.has("NOTIFICATIONS") ||
          domains.has("REFILLS") ||
          (domains.has("MEDICATIONS") &&
            !hasDoseStatus &&
            !temporal &&
            (hasReminderWord || isListQuery)))
      ) {
        return true;
      }
      // Medications + Refills requested explicitly together
      if (
        domains.has("MEDICATIONS") &&
        domains.has("REFILLS") &&
        !domains.has("PROFILE") &&
        !domains.has("DOCUMENTS") &&
        !domains.has("NOTIFICATIONS") &&
        !domains.has("REMINDERS")
      ) {
        const hasExplicitBoth =
          (lowerEng.includes(" and ") ||
            lowerRaw.includes(" અને ") ||
            lowerRaw.includes(" और ") ||
            lowerRaw.includes(" आणि ") ||
            lowerRaw.includes(" மற்றும் ")) &&
          !lowerEng.includes("with ") &&
          !lowerRaw.includes("સાથે ");
        if (hasExplicitBoth) return true;
        return false;
      }
      if (domains.size > 2) return true;
      return false;
    })();

    const isMultiDomain = hasMultipleDistinctDomains;

    let isFastPathEligible = false;
    let fastPathType = null;

    const isWhenShouldITake =
      lowerEng.includes("when should i take") || lowerEng.includes("when to take");
    const isClinicalAdviceEffective =
      isClinicalAdvice &&
      !domains.has("REMINDERS") &&
      !domains.has("REFILLS") &&
      (!medicationFacet || isWhenShouldITake);

    if (!isClinicalAdviceEffective && !requiresRag && !isMultiDomain) {
      if (detectedProfileField) {
        isFastPathEligible = true;
        fastPathType = "SPECIFIC_PROFILE_FIELD";
      } else if (hasSummaryRequest && domains.has("DOCUMENTS")) {
        isFastPathEligible = true;
        fastPathType = "DOCUMENT_SUMMARY";
      } else if (domains.has("REFILLS") && !domains.has("REMINDERS") && !domains.has("DOCUMENTS")) {
        isFastPathEligible = true;
        fastPathType = isCountQuery ? "COUNT" : "REFILL_STOCK";
      } else if (domains.has("REMINDERS") && !domains.has("REFILLS") && !domains.has("DOCUMENTS")) {
        isFastPathEligible = true;
        fastPathType = "REMINDER_OCCURRENCE";
      } else if (
        (isListQuery || statusFilter || typeFilter || documentFacet) &&
        domains.has("DOCUMENTS") &&
        !hasSummaryRequest
      ) {
        isFastPathEligible = true;
        fastPathType = isCountQuery ? "COUNT" : "LIST_DOCUMENT";
      } else if (isListQuery && domains.has("MEDICATIONS")) {
        isFastPathEligible = true;
        fastPathType = "LIST_MEDICATION";
      } else if (
        medicationFacet &&
        !isCountQuery &&
        domains.has("MEDICATIONS") &&
        !domains.has("DOCUMENTS") &&
        !domains.has("REMINDERS") &&
        !domains.has("REFILLS")
      ) {
        isFastPathEligible = true;
        fastPathType = "MEDICATION_FACET";
      } else if (isCountQuery) {
        isFastPathEligible = true;
        fastPathType = "COUNT";
      } else if (domains.has("NOTIFICATIONS") && !domains.has("DOCUMENTS")) {
        isFastPathEligible = true;
        fastPathType = "NOTIFICATION_STATUS";
      }
    }

    const domainList = Array.from(domains);
    const primaryDomain = domainList.length === 1 ? domainList[0] : domainList[0] || null;

    return {
      domains,
      intents,
      primaryDomain,
      isMultiDomain,
      isFastPathEligible,
      fastPathType,
      requiresRag,
      entities: {
        temporal,
        targetDate,
        specificField: detectedProfileField,
        statusFilter,
        typeFilter,
        isUnreadOnly,
        isCountQuery,
        isListQuery,
        medicationFacet,
        reminderFacet,
        refillFacet,
        documentFacet,
        notificationFacet,
      },
      cleanEng,
      cleanRaw,
      detectedLanguage,
    };
  }
}

const chatClassifier = new ChatClassifierService();

module.exports = {
  chatClassifier,
  ChatClassifierService,
  SPECIFIC_PROFILE_FIELDS,
  COUNT_KEYWORDS,
  LIST_KEYWORDS,
  CLINICAL_ADVICE_KEYWORDS,
  TEMPORAL_INDICATORS,
};
