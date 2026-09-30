const keywordDictionary = require("../../src/constants/keywordDictionary");
const { detectContextGraph } = require("../../src/services/ai/chat/ragContext.service");

describe("Keyword Refactor & Verification Checklist Tests", () => {
  describe("1. AGE_KEYWORDS Multilingual Coverage", () => {
    const ageQuestions = [
      { lang: "English", query: "what is my age" },
      { lang: "English", query: "how old am i" },
      { lang: "Gujarati", query: "મારી ઉંમર કેટલી છે" },
      { lang: "Gujarati", query: "હું કેટલા વર્ષનો છું" },
      { lang: "Hindi", query: "मेरी उम्र क्या है" },
      { lang: "Hindi", query: "मैं कितने साल का हूँ" },
      { lang: "Marathi", query: "माझे वय काय आहे" },
      { lang: "Marathi", query: "मी किती वर्षांचा आहे" },
      { lang: "Tamil", query: "என் வயது என்ன" },
      { lang: "Tamil", query: "எனக்கு என்ன வயது" },
    ];

    test.each(ageQuestions)("Matches Age query in $lang: $query", ({ query }) => {
      const match = keywordDictionary.AGE.includes(query);
      expect(match).toBe(true);
    });
  });

  describe("2. SUMMARY_KEYWORDS Multilingual Coverage", () => {
    const summaryQueries = [
      { lang: "English", query: "summarize my report" },
      { lang: "English", query: "tell me about my report" },
      { lang: "Gujarati", query: "રિપોર્ટ નો સારાંશ" },
      { lang: "Gujarati", query: "મારો રિપોર્ટ સમજાવો" },
      { lang: "Hindi", query: "मेरी रिपोर्ट का सारांश" },
      { lang: "Hindi", query: "मेरी रिपोर्ट समझाएं" },
      { lang: "Marathi", query: "माझ्या अहवालाचा सारांश" },
      { lang: "Marathi", query: "माझा अहवाल स्पष्ट करा" },
      { lang: "Tamil", query: "என் அறிக்கையின் சுருக்கம்" },
      { lang: "Tamil", query: "என் அறிக்கையை விளக்குங்கள்" },
    ];

    test.each(summaryQueries)("Matches Summary query in $lang: $query", ({ query }) => {
      const match = keywordDictionary.SUMMARY.some((kw) => query.includes(kw));
      expect(match).toBe(true);
    });
  });

  describe("3. MEDICATION_LIST_KEYWORDS Multilingual Coverage", () => {
    const medListQueries = [
      { lang: "English", query: "list my medications" },
      { lang: "English", query: "show my medications" },
      { lang: "Gujarati", query: "મારી દવાઓની યાદી" },
      { lang: "Gujarati", query: "મારી દવાઓ બતાવો" },
      { lang: "Hindi", query: "मेरी दवाओं की सूची" },
      { lang: "Hindi", query: "मेरी दवाएं दिखाएं" },
      { lang: "Marathi", query: "माझ्या औषधांची यादी" },
      { lang: "Marathi", query: "माझी औषधे दाखवा" },
      { lang: "Tamil", query: "என் மருந்துகளின் பட்டியல்" },
      { lang: "Tamil", query: "என் மருந்துகளைக் காட்டு" },
    ];

    test.each(medListQueries)("Matches Medication List query in $lang: $query", ({ query }) => {
      const match = keywordDictionary.MEDICATION_LIST.some((kw) => query.includes(kw));
      expect(match).toBe(true);
    });
  });

  describe("4. PROFILE Keywords & Profile Exclusions", () => {
    const profileQueries = [
      { lang: "English", query: "what is my name" },
      { lang: "English", query: "what is my blood group" },
      { lang: "English", query: "what are my allergies" },
      { lang: "Gujarati", query: "મારું નામ શું છે" },
      { lang: "Gujarati", query: "મારી પ્રોફાઇલ" },
      { lang: "Hindi", query: "मेरा नाम क्या है" },
      { lang: "Hindi", query: "मेरी प्रोफाइल" },
      { lang: "Marathi", query: "माझे नाव काय आहे" },
      { lang: "Marathi", query: "माझी प्रोफाइल" },
      { lang: "Tamil", query: "என் பெயர் என்ன" },
      { lang: "Tamil", query: "சுயவிவரம்" },
    ];

    test.each(profileQueries)("Matches Profile query in $lang: $query", ({ query }) => {
      const isDoc = keywordDictionary.PROFILE_EXCLUSIONS.some((kw) => query.includes(kw));
      expect(isDoc).toBe(false);
      const isProfile = keywordDictionary.PROFILE.some((kw) => query.includes(kw));
      expect(isProfile).toBe(true);
    });

    test("Properly excludes document/report patient queries", () => {
      const docQueries = [
        "what is the patient name in the report",
        "doctor name in uploaded report",
        "રિપોર્ટમાં દર્દીનું નામ શું છે",
        "रिपोर्ट में मरीज का नाम",
      ];

      docQueries.forEach((q) => {
        const isDoc = keywordDictionary.PROFILE_EXCLUSIONS.some((kw) => q.includes(kw));
        expect(isDoc).toBe(true);
      });
    });
  });

  describe("5. DOCUMENT & COMPARE Keywords", () => {
    test("Matches compare keywords in 5 languages", () => {
      const compareQueries = [
        "compare my last two reports",
        "તમારા રિપોર્ટની સરખામણી કરો",
        "दोनों रिपोर्ट की तुलना करें",
        "अहवालाची तुलना करा",
        "அறிக்கைகளை ஒப்பிடுக",
      ];

      compareQueries.forEach((q) => {
        const hasCompare = keywordDictionary.COMPARE.some((kw) => q.includes(kw));
        expect(hasCompare).toBe(true);
      });
    });

    test("Matches biomarker keywords", () => {
      const biomarkers = ["hemoglobin", "glucose", "creatinine", "cholesterol", "thyroid"];
      biomarkers.forEach((b) => {
        expect(keywordDictionary.DOCUMENT_CONTENT_BIOMARKER.includes(b)).toBe(true);
      });
    });

    test("Matches document catalog listing keywords", () => {
      const listingQueries = [
        "list all documents",
        "show my reports",
        "how many reports do i have",
        "બધા રિપોર્ટ બતાવો",
        "सभी रिपोर्ट दिखाएं",
        "सर्व अहवाल दाखवा",
        "பட்டியல்",
      ];

      listingQueries.forEach((q) => {
        const hasList = keywordDictionary.DOCUMENT_LIST.some((kw) => q.includes(kw));
        expect(hasList).toBe(true);
      });
    });
  });

  describe("6. detectContextGraph Domain Selection Multi-lingual", () => {
    test("Correctly activates context domains", () => {
      expect(detectContextGraph("Did I take my dose today?").has("REMINDERS")).toBe(true);
      expect(detectContextGraph("How many refills remaining?").has("REFILLS")).toBe(true);
      expect(detectContextGraph("How many refills remaining?").has("MEDICATIONS")).toBe(true);
      expect(detectContextGraph("Show all my uploaded reports").has("DOCUMENTS")).toBe(true);
      expect(detectContextGraph("Show my push notification alerts").has("NOTIFICATIONS")).toBe(
        true,
      );
      expect(detectContextGraph("What is my patient code and login method?").has("PROFILE")).toBe(
        true,
      );
      expect(detectContextGraph("Give me a full summary and overview").has("PROFILE")).toBe(true);
      expect(detectContextGraph("Give me a full summary and overview").has("DOCUMENTS")).toBe(true);
    });
  });
});
