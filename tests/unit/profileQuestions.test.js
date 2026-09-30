const { chatFastPath } = require("../../src/services/ai/chat/chatFastPath.service");
const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const patientRepository = require("../../src/repositories/patientRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/chatSessionRepository");

describe("10 Core Profile Questions Suite (Multilingual Parity)", () => {
  const mockUserId = "usr-profile-suite-1";
  const mockSessionId = "sess-profile-suite-1";

  const samplePatient = {
    id: mockUserId,
    patientCode: "PAT1001",
    firstName: "John",
    lastName: "Doe",
    fullName: "John Doe",
    email: "john.doe@example.com",
    mobile: "+1234567890",
    dateOfBirth: "1990-05-15",
    gender: "male",
    bloodGroup: "O+",
    allergies: ["Penicillin", "Peanuts"],
    firebaseUid: "fb-uid-123",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    patientRepository.findById.mockResolvedValue(samplePatient);
    chatSessionRepository.appendMessage.mockResolvedValue({ id: "msg-1" });
  });

  function classifyQuestion(question, detectedLanguage = "english") {
    return chatClassifier.classify({
      rawQuestion: question,
      englishQuestion: question,
      detectedLanguage,
    });
  }

  describe("English - 10 Core Profile Questions", () => {
    test("Q1: What is my name?", async () => {
      const question = "What is my name?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("name");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Your registered name is John Doe.");
    });

    test("Q2: What is my age?", async () => {
      const question = "What is my age?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("age");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toMatch(
        /Based on your date of birth \(1990-05-15\), you are \d+ years old\./,
      );
    });

    test("Q3: What is my date of birth?", async () => {
      const question = "What is my date of birth?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("dateOfBirth");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toBe("Your registered date of birth is 1990-05-15.");
    });

    test("Q4: What is my gender?", async () => {
      const question = "What is my gender?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("gender");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toBe("Your registered gender is male.");
    });

    test("Q5: What is my blood group?", async () => {
      const question = "What is my blood group?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("bloodGroup");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toBe("Your blood group is O+.");
    });

    test("Q6: Show my profile", async () => {
      const question = "Show my profile";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("fullProfile");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Official Profile Details:");
      expect(res.reply).toContain("John Doe");
      expect(res.reply).toContain("john.doe@example.com");
      expect(res.reply).toContain("+1234567890");
      expect(res.reply).toContain("1990-05-15");
      expect(res.reply).toContain("male");
      expect(res.reply).toContain("O+");
    });

    test("Q7: What is my personal information?", async () => {
      const question = "What is my personal information?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("fullProfile");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Official Profile Details:");
      expect(res.reply).toContain("John Doe");
    });

    test("Q8: What is my stored information?", async () => {
      const question = "What is my stored information?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("fullProfile");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toContain("Official Profile Details:");
      expect(res.reply).toContain("John Doe");
    });

    test("Q9: What is my phone number?", async () => {
      const question = "What is my phone number?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("mobile");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toBe("Your registered mobile number is +1234567890.");
    });

    test("Q10: What is my email address?", async () => {
      const question = "What is my email address?";
      const classification = classifyQuestion(question);
      expect(classification.entities.specificField).toBe("email");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "english" },
        classification,
      );
      expect(res.reply).toBe("Your registered email is john.doe@example.com.");
    });
  });

  describe("Multilingual Equivalence for Core Profile Fields", () => {
    test("Gujarati: Gender question (મારી જાતિ શું છે?)", async () => {
      const question = "મારી જાતિ શું છે?";
      const classification = classifyQuestion(question, "gujarati");
      expect(classification.entities.specificField).toBe("gender");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "gujarati" },
        classification,
      );
      expect(res.reply).toBe("તમારી નોંધાયેલ જાતિ male છે.");
    });

    test("Hindi: Gender question (मेरा लिंग क्या है?)", async () => {
      const question = "मेरा लिंग क्या है?";
      const classification = classifyQuestion(question, "hindi");
      expect(classification.entities.specificField).toBe("gender");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "hindi" },
        classification,
      );
      expect(res.reply).toBe("आपका पंजीकृत लिंग male है।");
    });

    test("Marathi: Gender question (माझे लिंग काय आहे?)", async () => {
      const question = "माझे लिंग काय आहे?";
      const classification = classifyQuestion(question, "marathi");
      expect(classification.entities.specificField).toBe("gender");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "marathi" },
        classification,
      );
      expect(res.reply).toBe("तुमचे नोंदणीकृत लिंग male आहे.");
    });

    test("Tamil: Gender question (என் பாலினம் என்ன?)", async () => {
      const question = "என் பாலினம் என்ன?";
      const classification = classifyQuestion(question, "tamil");
      expect(classification.entities.specificField).toBe("gender");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "tamil" },
        classification,
      );
      expect(res.reply).toBe("உங்கள் பதிவு செய்யப்பட்ட பாலினம் male.");
    });

    test("Gujarati: Personal info (મારી વ્યક્તિગત માહિતી)", async () => {
      const question = "મારી વ્યક્તિગત માહિતી";
      const classification = classifyQuestion(question, "gujarati");
      expect(classification.entities.specificField).toBe("fullProfile");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "gujarati" },
        classification,
      );
      expect(res.reply).toContain("સત્તાવાર પ્રોફાઇલ વિગતો:");
      expect(res.reply).toContain("John Doe");
    });

    test("Hindi: Stored info (मेरी संग्रहीत जानकारी)", async () => {
      const question = "मेरी संग्रहीत जानकारी";
      const classification = classifyQuestion(question, "hindi");
      expect(classification.entities.specificField).toBe("fullProfile");

      const res = await chatFastPath.handleSpecificProfileField(
        { userId: mockUserId, sessionId: mockSessionId, question, detectedLanguage: "hindi" },
        classification,
      );
      expect(res.reply).toContain("आधिकारिक प्रोफ़ाइल विवरण:");
      expect(res.reply).toContain("John Doe");
    });
  });
});
