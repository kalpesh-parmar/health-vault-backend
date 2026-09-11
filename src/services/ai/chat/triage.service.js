const prompts = require("../prompts");
const { normalizeLanguage } = require("../../../utils/commonUtils");

const EMERGENCY_WARNING_I18N = {
  english: `This may require urgent medical attention.
Please contact emergency services or visit the nearest emergency department immediately.
The following information is general guidance and not a diagnosis.`,
  gujarati: `આ માટે તાત્કાલિક તબીબી સારવારની જરૂર પડી શકે છે.
કૃપા કરીને તાત્કાલિક કટોકટી સેવાઓનો સંપર્ક કરો અથવા નજીકના કટોકટી વિભાગની મુલાકાત લો.
નીચેની માહિતી સામાન્ય માર્ગદર્શન છે અને કોઈ નિદાન નથી.`,
  hindi: `इसके लिए तत्काल चिकित्सा सहायता की आवश्यकता हो सकती है।
कृपया तुरंत आपातकालीन सेवाओं से संपर्क करें या निकटतम आपातकालीन विभाग में जाएं।
निम्नलिखित जानकारी सामान्य मार्गदर्शन है और कोई निदान नहीं है।`,
  marathi: `यासाठी त्वरित वैद्यकीय लक्ष देण्याची आवश्यकता असू शकते.
कृपया त्वरित आपत्कालीन सेवांशी संपर्क साधा किंवा जवळच्या आपत्कालीन विभागात जा.
खालील माहिती सामान्य मार्गदर्शन आहे आणि निदान नाही.`,
  tamil: `இதற்கு அவசர மருத்துவ உதவி தேவைப்படலாம்.
அவசர சேவைகளைத் தொடர்பு கொள்ளவும் அல்லது உடனடியாக அருகிலுள்ள அவசர சிகிச்சைப் பிரிவுக்குச் செல்லவும்.
பின்வரும் தகவல் பொதுவான வழிகாட்டுதல் மட்டுமே, இது ஒரு நோய் கண்டறிதல் அல்ல.`,
};

class TriageService {
  /**
   * Evaluates text for life-threatening or urgent medical red-flag keywords.
   * @param {string} text - User message text
   * @returns {boolean} True if emergency keyword is found
   */
  detectEmergency(text) {
    const cleanText = String(text || "").toLowerCase();
    return prompts.EMERGENCY_KEYWORDS.some((keyword) => cleanText.includes(keyword));
  }

  /**
   * Retrieves localized emergency warning text.
   * @param {string} preferredLanguage - Target language code/name
   * @returns {string} Localized warning text
   */
  getEmergencyWarning(preferredLanguage = "english") {
    const normLang = normalizeLanguage(preferredLanguage);
    return EMERGENCY_WARNING_I18N[normLang] || EMERGENCY_WARNING_I18N.english;
  }

  /**
   * Builds standardized emergency chat response.
   * @param {string} preferredLanguage - Target language code/name
   * @param {string} mode - Current chat mode
   * @returns {object} Standard chat emergency response
   */
  buildEmergencyResponse(preferredLanguage = "english", mode = "GENERAL_HEALTH") {
    return {
      answer: this.getEmergencyWarning(preferredLanguage),
      mode,
      emergency: true,
      citations: [],
    };
  }
}

const triageService = new TriageService();

module.exports = {
  EMERGENCY_WARNING_I18N,
  TriageService,
  triageService,
};
