const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");

describe("ChatClassifierService — Universal Multilingual Intent & Entity Tests", () => {
  describe("1. PROFILE Domain & Specific Fields", () => {
    test("English: what is my date of birth -> SPECIFIC_FIELD (dateOfBirth)", () => {
      const res = chatClassifier.classify({
        rawQuestion: "what is my date of birth",
        englishQuestion: "what is my date of birth",
        detectedLanguage: "english",
      });

      expect(res.domains.has("PROFILE")).toBe(true);
      expect(res.entities.specificField).toBe("dateOfBirth");
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("SPECIFIC_PROFILE_FIELD");
    });

    test("Gujarati: મારી ઉંમર કેટલી છે -> SPECIFIC_FIELD (age)", () => {
      const res = chatClassifier.classify({
        rawQuestion: "મારી ઉંમર કેટલી છે",
        englishQuestion: "how old am I",
        detectedLanguage: "gujarati",
      });

      expect(res.domains.has("PROFILE")).toBe(true);
      expect(res.entities.specificField).toBe("age");
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("SPECIFIC_PROFILE_FIELD");
    });

    test("Hindi: मेरा ब्लड ग्रुप क्या है -> SPECIFIC_FIELD (bloodGroup)", () => {
      const res = chatClassifier.classify({
        rawQuestion: "मेरा ब्लड ग्रुप क्या है",
        englishQuestion: "what is my blood group",
        detectedLanguage: "hindi",
      });

      expect(res.domains.has("PROFILE")).toBe(true);
      expect(res.entities.specificField).toBe("bloodGroup");
      expect(res.isFastPathEligible).toBe(true);
    });

    test("Marathi: माझे नाव काय आहे -> SPECIFIC_FIELD (name)", () => {
      const res = chatClassifier.classify({
        rawQuestion: "माझे नाव काय आहे",
        englishQuestion: "what is my name",
        detectedLanguage: "marathi",
      });

      expect(res.domains.has("PROFILE")).toBe(true);
      expect(res.entities.specificField).toBe("name");
      expect(res.isFastPathEligible).toBe(true);
    });

    test("Tamil: என் ஒவ்வாமை என்ன -> SPECIFIC_FIELD (allergies)", () => {
      const res = chatClassifier.classify({
        rawQuestion: "என் ஒவ்வாமை என்ன",
        englishQuestion: "what are my allergies",
        detectedLanguage: "tamil",
      });

      expect(res.domains.has("PROFILE")).toBe(true);
      expect(res.entities.specificField).toBe("allergies");
      expect(res.isFastPathEligible).toBe(true);
    });
  });

  describe("2. MEDICATIONS & LIST / COUNT", () => {
    test("English: List my medicines -> MEDICATIONS + LIST", () => {
      const res = chatClassifier.classify({
        rawQuestion: "List my medicines",
        englishQuestion: "List my medicines",
        detectedLanguage: "english",
      });

      expect(res.domains.has("MEDICATIONS")).toBe(true);
      expect(res.intents.has("LIST")).toBe(true);
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("LIST_MEDICATION");
    });

    test("Gujarati: મારી દવાઓની યાદી આપો -> LIST_MEDICATION", () => {
      const res = chatClassifier.classify({
        rawQuestion: "મારી દવાઓની યાદી આપો",
        englishQuestion: "give me list of my medicines",
        detectedLanguage: "gujarati",
      });

      expect(res.domains.has("MEDICATIONS")).toBe(true);
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("LIST_MEDICATION");
    });

    test("Hindi: मुझे कितनी दवाइयां लेनी हैं -> COUNT", () => {
      const res = chatClassifier.classify({
        rawQuestion: "मुझे कितनी दवाइयां लेनी हैं",
        englishQuestion: "how many medicines do I have to take",
        detectedLanguage: "hindi",
      });

      expect(res.domains.has("MEDICATIONS")).toBe(true);
      expect(res.intents.has("COUNT")).toBe(true);
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("COUNT");
    });
  });

  describe("3. REMINDERS & TEMPORAL OCCURRENCES", () => {
    test("English: Did I miss any medicine today? -> REMINDERS + today", () => {
      const res = chatClassifier.classify({
        rawQuestion: "Did I miss any medicine today?",
        englishQuestion: "Did I miss any medicine today?",
        detectedLanguage: "english",
      });

      expect(res.domains.has("REMINDERS")).toBe(true);
      expect(res.entities.temporal).toBe("today");
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("REMINDER_OCCURRENCE");
    });

    test("English: Show me the medicine I missed yesterday -> REMINDERS + yesterday", () => {
      const res = chatClassifier.classify({
        rawQuestion: "Show me the medicine I missed yesterday",
        englishQuestion: "Show me the medicine I missed yesterday",
        detectedLanguage: "english",
      });

      expect(res.domains.has("REMINDERS")).toBe(true);
      expect(res.entities.temporal).toBe("yesterday");
      expect(res.entities.targetDate).toBeDefined();
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("REMINDER_OCCURRENCE");
    });

    test("Gujarati: આજે મારે કઈ દવા લેવાની છે? -> REMINDERS + today", () => {
      const res = chatClassifier.classify({
        rawQuestion: "આજે મારે કઈ દવા લેવાની છે?",
        englishQuestion: "what medicine do I have to take today?",
        detectedLanguage: "gujarati",
      });

      expect(res.domains.has("REMINDERS")).toBe(true);
      expect(res.entities.temporal).toBe("today");
      expect(res.isFastPathEligible).toBe(true);
    });

    test("Marathi: काल मी कोणते औषध चुकवले -> REMINDERS + yesterday", () => {
      const res = chatClassifier.classify({
        rawQuestion: "काल मी कोणते औषध चुकवले",
        englishQuestion: "which medicine did I miss yesterday",
        detectedLanguage: "marathi",
      });

      expect(res.domains.has("REMINDERS")).toBe(true);
      expect(res.entities.temporal).toBe("yesterday");
      expect(res.isFastPathEligible).toBe(true);
    });
  });

  describe("4. REFILLS & STOCK", () => {
    test("English: Which medicines need a refill? -> REFILLS", () => {
      const res = chatClassifier.classify({
        rawQuestion: "Which medicines need a refill?",
        englishQuestion: "Which medicines need a refill?",
        detectedLanguage: "english",
      });

      expect(res.domains.has("REFILLS")).toBe(true);
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("REFILL_STOCK");
    });

    test("Tamil: என் மருந்து இருப்பு எவ்வளவு -> REFILLS", () => {
      const res = chatClassifier.classify({
        rawQuestion: "என் மருந்து இருப்பு எவ்வளவு",
        englishQuestion: "how much is my medicine stock",
        detectedLanguage: "tamil",
      });

      expect(res.domains.has("REFILLS")).toBe(true);
      expect(res.isFastPathEligible).toBe(true);
    });
  });

  describe("5. NOTIFICATIONS", () => {
    test("English: Do I have any unread notifications? -> NOTIFICATIONS + isUnreadOnly", () => {
      const res = chatClassifier.classify({
        rawQuestion: "Do I have any unread notifications?",
        englishQuestion: "Do I have any unread notifications?",
        detectedLanguage: "english",
      });

      expect(res.domains.has("NOTIFICATIONS")).toBe(true);
      expect(res.entities.isUnreadOnly).toBe(true);
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("NOTIFICATION_STATUS");
    });

    test("Marathi: मला काही न वाचलेल्या सूचना आहेत का? -> NOTIFICATIONS + isUnreadOnly", () => {
      const res = chatClassifier.classify({
        rawQuestion: "मला काही न वाचलेल्या सूचना आहेत का?",
        englishQuestion: "do I have any unread notifications",
        detectedLanguage: "marathi",
      });

      expect(res.domains.has("NOTIFICATIONS")).toBe(true);
      expect(res.entities.isUnreadOnly).toBe(true);
      expect(res.isFastPathEligible).toBe(true);
    });
  });

  describe("6. DOCUMENTS & RAG ROUTING", () => {
    test("English: List my uploaded documents -> LIST_DOCUMENT (Fast-Path, no vector search)", () => {
      const res = chatClassifier.classify({
        rawQuestion: "List my uploaded documents",
        englishQuestion: "List my uploaded documents",
        detectedLanguage: "english",
      });

      expect(res.domains.has("DOCUMENTS")).toBe(true);
      expect(res.requiresRag).toBe(false);
      expect(res.isFastPathEligible).toBe(true);
      expect(res.fastPathType).toBe("LIST_DOCUMENT");
    });

    test("English: What is my hemoglobin in my latest report? -> requiresRag = true", () => {
      const res = chatClassifier.classify({
        rawQuestion: "What is my hemoglobin in my latest report?",
        englishQuestion: "What is my hemoglobin in my latest report?",
        detectedLanguage: "english",
      });

      expect(res.domains.has("DOCUMENTS")).toBe(true);
      expect(res.requiresRag).toBe(true);
      expect(res.isFastPathEligible).toBe(false);
    });

    test("English: Can I take aspirin with food? -> CLINICAL_ADVICE (Not Fast-Path)", () => {
      const res = chatClassifier.classify({
        rawQuestion: "Can I take aspirin with food?",
        englishQuestion: "Can I take aspirin with food?",
        detectedLanguage: "english",
      });

      expect(res.intents.has("CLINICAL_ADVICE")).toBe(true);
      expect(res.isFastPathEligible).toBe(false);
    });
  });

  describe("7. MULTI-DOMAIN QUERIES", () => {
    test("English: Which medicines do I need to refill and when is my next dose? -> Multi-Domain", () => {
      const res = chatClassifier.classify({
        rawQuestion: "Which medicines do I need to refill and when is my next dose?",
        englishQuestion: "Which medicines do I need to refill and when is my next dose?",
        detectedLanguage: "english",
      });

      expect(res.domains.has("REFILLS")).toBe(true);
      expect(res.domains.has("REMINDERS")).toBe(true);
      expect(res.isMultiDomain).toBe(true);
      // Multi-domain requires synthesis across domains so not single fast-path
      expect(res.isFastPathEligible).toBe(false);
    });
  });
});
