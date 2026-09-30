/**
 * Safe shared helpers for chat and ragContext services.
 */

/**
 * Picks a localized string or template with fallback strictly to english.
 * @param {Record<string, any>} map
 * @param {string} lang
 * @returns {any}
 */
function pickLang(map, lang) {
  if (!map) return undefined;
  return map[lang] || map.english;
}

/**
 * Checks if a string contains any of the keywords in a list.
 * @param {string} text
 * @param {string[]} list
 * @returns {boolean}
 */
function hasAny(text, list) {
  if (!text || !Array.isArray(list)) return false;
  return list.some((kw) => text.includes(kw));
}

/**
 * Exact replica of inline date conversion:
 * x instanceof Date ? x.toISOString().split("T")[0] : String(x).split("T")[0]
 * @param {any} value
 * @returns {string}
 */
function toIsoDateOnly(value) {
  return value instanceof Date ? value.toISOString().split("T")[0] : String(value).split("T")[0];
}

async function streamTextLikeChat(text, onChunk, abortSignal, delayMs = 15) {
  if (!text || !onChunk) return;
  const words = text.split(/(\s+)/);
  for (const word of words) {
    if (abortSignal?.aborted) break;
    onChunk(word);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Formats a medication schedule object or array into a clean, human-readable string.
 * Converts { "Morning": "08:00:00", "Night": "20:00:00" } into localized strings
 * without raw JSON stringification.
 * @param {any} sched
 * @param {string} [lang="english"]
 * @returns {string}
 */
function formatMedicationSchedule(sched, lang = "english") {
  if (!sched) return "";
  if (Array.isArray(sched)) {
    return sched.filter(Boolean).join(", ");
  }
  let obj = sched;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return obj;
    }
  }

  const slotMap = {
    morning: {
      english: "Morning",
      gujarati: "સવાર",
      hindi: "सुबह",
      marathi: "सकाळ",
      tamil: "காலை",
    },
    noon: { english: "Noon", gujarati: "બપોર", hindi: "दोपहर", marathi: "दुपार", tamil: "மதியம்" },
    afternoon: {
      english: "Afternoon",
      gujarati: "બપોર",
      hindi: "दोपहर",
      marathi: "दुपार",
      tamil: "மதியம்",
    },
    evening: {
      english: "Evening",
      gujarati: "સાંજ",
      hindi: "शाम",
      marathi: "संध्याकाळ",
      tamil: "மாலை",
    },
    night: { english: "Night", gujarati: "રાત", hindi: "रात", marathi: "रात्र", tamil: "இரவு" },
  };

  if (typeof obj === "object" && obj !== null) {
    const entries = Object.entries(obj).filter(([, v]) => v);
    if (!entries.length) return "";
    return entries
      .map(([slot, time]) => {
        let displayTime = time;
        if (typeof time === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(time)) {
          const parts = time.split(":");
          const h = parseInt(parts[0], 10);
          const m = parts[1];
          const ampm = h >= 12 ? "PM" : "AM";
          const h12 = h % 12 || 12;
          displayTime = `${String(h12).padStart(2, "0")}:${m} ${ampm}`;
        }
        const sKey = String(slot || "").toLowerCase();
        const localizedSlot = slotMap[sKey]
          ? slotMap[sKey][lang] || slotMap[sKey].english
          : slot
            ? slot.charAt(0).toUpperCase() + slot.slice(1)
            : "";
        return `${localizedSlot}: ${displayTime}`;
      })
      .join(", ");
  }
  return String(obj);
}

/**
 * Strict occurrence status determination:
 * 1. Taken: status is COMPLETED or TAKEN. Once taken, it can never be missed.
 * 2. Missed: not taken AND (status is SKIPPED or MISSED or isOverdue is true).
 * 3. Pending: neither taken nor missed.
 */
function isOccurrenceTaken(o) {
  if (!o) return false;
  const st = String(o.status || "").toUpperCase();
  return st === "TAKEN" || st === "COMPLETED";
}

function isOccurrenceMissed(o) {
  if (!o || isOccurrenceTaken(o)) return false;
  const st = String(o.status || "").toUpperCase();
  return st === "SKIPPED" || st === "MISSED" || Boolean(o.isOverdue);
}

function isOccurrencePending(o) {
  return !isOccurrenceTaken(o) && !isOccurrenceMissed(o);
}

/**
 * Sanitizes final chat responses to strip internal prompt artifacts,
 * specifically page metadata like '(the current page is 1 of 1)', '(Page X of Y)', etc.
 */
function sanitizeChatResponse(text) {
  if (typeof text !== "string") return text;

  let cleaned = text
    .replace(/\(?(?:the\s+)?current page is \d+(?:\s+of\s+\d+)?\)?/gi, "")
    .replace(/\(?page \d+(?:\s+of\s+\d+)?\)?/gi, "")
    .replace(/Uploaded Document List Array(?:\s*\(Page \d+\))?:?/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

/**
 * Formats raw document type enum strings into clean, human-readable labels in preferred language.
 */
function formatDocumentType(type, lang = "english") {
  if (!type) return "Medical Document";
  const map = {
    PRESCRIPTION: {
      english: "Prescription",
      gujarati: "પ્રિસ્ક્રિપ્શન",
      hindi: "पर्चा (प्रिस्क्रिप्शन)",
      marathi: "प्रिस्क्रिप्शन",
      tamil: "மருந்து சீட்டு",
    },
    LAB_REPORT: {
      english: "Lab Report",
      gujarati: "લેબ રિપોર્ટ",
      hindi: "लैब रिपोर्ट",
      marathi: "लॅब रिपोर्ट",
      tamil: "லேப் அறிக்கை",
    },
    IMAGING_REPORT: {
      english: "Imaging Report",
      gujarati: "ઇમેજિંગ રિપોર્ટ",
      hindi: "इमेजिंग रिपोर्ट",
      marathi: "इमेजिंग रिपोर्ट",
      tamil: "இமேஜிங் அறிக்கை",
    },
    DISCHARGE_SUMMARY: {
      english: "Discharge Summary",
      gujarati: "ડિસ્ચાર્જ સમરી",
      hindi: "डिस्चार्ज समरी",
      marathi: "डिस्चार्ज समरी",
      tamil: "டிஸ்சાર્ஜ் சுருக்கம்",
    },
    CONSULTATION_REPORT: {
      english: "Consultation Report",
      gujarati: "કન્સલ્ટેશન રિપોર્ટ",
      hindi: "परामर्श रिपोर्ट",
      marathi: "सल्लागार अहवाल",
      tamil: "ஆலோசனை அறிக்கை",
    },
    SURGERY_PROCEDURE_REPORT: {
      english: "Surgery / Procedure Report",
      gujarati: "સર્જરી રિપોર્ટ",
      hindi: "सर्जरी रिपोर्ट",
      marathi: "शस्त्रक्रिया अहवाल",
      tamil: "அறுவை சிகிச்சை அறிக்கை",
    },
    VACCINATION_RECORD: {
      english: "Vaccination Record",
      gujarati: "રસીકરણ રેકોર્ડ",
      hindi: "टीकाकरण रिकॉर्ड",
      marathi: "लसीकरण नोंद",
      tamil: "தடுப்பூசி பதிவு",
    },
    MEDICAL_CERTIFICATE: {
      english: "Medical Certificate",
      gujarati: "મેડિકલ સર્ટિફિકેટ",
      hindi: "मेडिकल सर्टिफिकेट",
      marathi: "वैद्यकीय प्रमाणपत्र",
      tamil: "மருத்துவ சான்றிதழ்",
    },
    OTHER_MEDICAL_DOCUMENT: {
      english: "Other Medical Document",
      gujarati: "અન્ય મેડિકલ દસ્તાવેજ",
      hindi: "अन्य मेडिकल दस्तावेज़",
      marathi: "इतर वैद्यकीय दस्तऐवज",
      tamil: "பிற மருத்துவ ஆவணம்",
    },
    medical_document: {
      english: "Medical Document",
      gujarati: "મેડિકલ દસ્તાવેજ",
      hindi: "मेडिकल दस्तावेज़",
      marathi: "वैद्यकीय दस्तऐवज",
      tamil: "மருத்துவ ஆவணம்",
    },
  };
  const key = String(type).trim();
  if (map[key]) {
    return map[key][lang] || map[key].english;
  }
  return String(type)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Humanizes food frequency enum values into preferred language.
 */
function humanizeFoodFreq(val, lang = "english") {
  if (!val) return null;
  const key = String(val).toUpperCase();
  const map = {
    AFTER_FOOD: {
      english: "After food",
      gujarati: "જમ્યા પછી",
      hindi: "भोजन के बाद",
      marathi: "जेवणानंतर",
      tamil: "உணவுக்கு பின்",
    },
    BEFORE_FOOD: {
      english: "Before food",
      gujarati: "જમતા પહેલાં",
      hindi: "भोजन से पहले",
      marathi: "जेवणापूर्वी",
      tamil: "உணவுக்கு முன்",
    },
    WITH_FOOD: {
      english: "With food",
      gujarati: "ખોરાક સાથે",
      hindi: "भोजन के साथ",
      marathi: "अन्नासोबत",
      tamil: "உணவோடு",
    },
    EMPTY_STOMACH: {
      english: "Empty stomach",
      gujarati: "ખાલી પેટે",
      hindi: "खाली पेट",
      marathi: "रिकाम्या पोटी",
      tamil: "வெறும் வயிற்றில்",
    },
  };
  const entry = map[key];
  if (entry) {
    return entry[lang] || entry.english;
  }
  return val;
}

/**
 * Humanizes frequency string values into preferred language.
 */
function humanizeFrequency(val, lang = "english") {
  if (!val) return null;
  const key = String(val).trim().toLowerCase();
  const map = {
    "once daily": {
      english: "Once Daily",
      gujarati: "દિવસમાં એક વાર",
      hindi: "दिन में एक बार",
      marathi: "दिवसातून एकदा",
      tamil: "நாளைக்கு ஒரு முறை",
    },
    "twice daily": {
      english: "Twice Daily",
      gujarati: "દિવસમાં બે વાર",
      hindi: "दिन में दो बार",
      marathi: "दिवसातून दोनदा",
      tamil: "நாளைக்கு இரு முறை",
    },
    "thrice daily": {
      english: "Thrice Daily",
      gujarati: "દિવસમાં ત્રણ વાર",
      hindi: "दिन में तीन बार",
      marathi: "दिवसातून तीनदा",
      tamil: "நாளைக்கு மூன்று முறை",
    },
    "four times daily": {
      english: "4 Times Daily",
      gujarati: "દિવસમાં ૪ વાર",
      hindi: "दिन में ४ बार",
      marathi: "दिवसातून ४ वेळा",
      tamil: "நாளைக்கு 4 முறை",
    },
    "as needed": {
      english: "As Needed",
      gujarati: "જરૂર મુજબ",
      hindi: "आवश्यकतानुसार",
      marathi: "गरजेनुसार",
      tamil: "தேவைக்கேற்ப",
    },
  };
  const entry = map[key];
  if (entry) {
    return entry[lang] || entry.english;
  }
  return val;
}

module.exports = {
  pickLang,
  hasAny,
  toIsoDateOnly,
  streamTextLikeChat,
  formatMedicationSchedule,
  isOccurrenceTaken,
  isOccurrenceMissed,
  isOccurrencePending,
  sanitizeChatResponse,
  formatDocumentType,
  humanizeFoodFreq,
  humanizeFrequency,
};
