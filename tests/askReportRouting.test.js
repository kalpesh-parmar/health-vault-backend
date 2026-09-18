const { onboardingService } = require("../src/services/ai/chat/onboarding.service");
const { getLocalizedResponse } = require("../src/services/ai/chat/onboarding/stepResponseBuilder");
const { db } = require("../src/configs/db");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const patientRepository = require("../src/repositories/patientRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const { ollamaClient } = require("../src/clients/ollamaClient");

describe("Phase 12: Ask About My Report Routing & Data Fidelity Tests", () => {
  const mockDoc = {
    id: "doc-valjibhai-123",
    userId: "user-valji",
    patientName: "Valjibhai Ranoliya",
    reportDate: "2024-08-30",
    doctorName: "Dr. Sachin P. Vagadia",
    hospitalName: "Trimurti Medical Store",
    documentType: "LAB_REPORT",
    summaryEnglish:
      "Imaging and lab report showing elevated Random Blood Sugar and elevated HbA1c.",
    structuredExtractedData: {
      patientInfo: {
        name: "Valjibhai Ranoliya",
        age: 70,
        gender: "male",
        uhid: "5069200904",
        doctorName: "Dr. Sachin P. Vagadia",
        hospitalName: "Trimurti Medical Store",
      },
      tests: [
        {
          name: "Random Blood Sugar",
          value: "271",
          unit: "mg/dL",
          status: "Abnormal (> 200: Provisional Diabetes)",
          referenceRange: "< 140 mg/dL",
          isAbnormal: true,
        },
        {
          name: "HbA1c",
          value: "9.0",
          unit: "%",
          status: "Abnormal (>= 6.5: Diabetes)",
          referenceRange: "< 5.7%",
          isAbnormal: true,
        },
        {
          name: "Hemoglobin",
          value: "11.20",
          unit: "gm%",
          status: "Normal",
          referenceRange: "11.0 - 16.0 gm%",
          isAbnormal: false,
        },
        {
          name: "Prothrombin Time (PT)",
          value: "18.5",
          unit: "seconds",
          status: "Normal",
          referenceRange: "13.87 - 18.27",
          isAbnormal: false,
        },
      ],
      summaryEnglish:
        "Imaging and lab report showing elevated Random Blood Sugar and elevated HbA1c.",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
    jest.spyOn(patientRepository, "findById").mockResolvedValue({ id: "user-valji" });
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({ data: {} });
    jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});

    const selectMock = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockDoc]),
          }),
        }),
      }),
    });
    jest.spyOn(db, "select").mockImplementation(selectMock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("1. Gujarati button tap 'મારા રિપોર્ટ વિશે પૂછો' routes to ASK_REPORT without falling into RAG chat", async () => {
    const state = {
      preferredLanguage: "gujarati",
      currentStep: "MEDICINE_OPTIONS",
      userId: "user-valji",
      documentId: "doc-valjibhai-123",
      isOnboardingCompleted: false,
    };

    const res = await onboardingService.chat(
      "ASK_REPORT",
      [],
      state,
      "user-valji",
      null,
      null,
      false,
      "મારા રિપોર્ટ વિશે પૂછો", // displayLabel
    );

    expect(res.action).toBe("ASK_REPORT");
    expect(res.document).toBeDefined();
    expect(res.document.id).toBe("doc-valjibhai-123");
  });

  test("2. Hindi button tap 'मेरी रिपोर्ट के बारे में पूछें' routes to ASK_REPORT", async () => {
    const state = {
      preferredLanguage: "hindi",
      currentStep: "MEDICINE_OPTIONS",
      userId: "user-valji",
      documentId: "doc-valjibhai-123",
      isOnboardingCompleted: false,
    };

    const res = await onboardingService.chat(
      "ASK_REPORT",
      [],
      state,
      "user-valji",
      null,
      null,
      false,
      "मेरी रिपोर्ट के बारे में पूछें",
    );

    expect(res.action).toBe("ASK_REPORT");
    expect(res.document).toBeDefined();
  });

  test("3. ASK_REPORT payload contains patientDetails, abnormalResults, and normalResults", async () => {
    const state = {
      preferredLanguage: "gujarati",
      currentStep: "ASK_REPORT",
      userId: "user-valji",
      documentId: "doc-valjibhai-123",
      isOnboardingCompleted: false,
    };

    const res = await getLocalizedResponse("ASK_REPORT", state);

    expect(res.action).toBe("ASK_REPORT");
    const doc = res.document;
    expect(doc).toBeDefined();

    // Patient Details
    expect(doc.patientDetails).toBeDefined();
    expect(doc.patientDetails.name).toBe("Valjibhai Ranoliya");
    expect(doc.patientDetails.age).toBe(70);
    expect(doc.patientDetails.uhid).toBe("5069200904");

    // Abnormal Results (Random Blood Sugar, HbA1c)
    expect(doc.abnormalResults).toBeDefined();
    expect(doc.abnormalResults.length).toBe(2);
    expect(doc.abnormalResults[0].name).toBe("Random Blood Sugar");
    expect(doc.abnormalResults[0].value).toBe("271");
    expect(doc.abnormalResults[0].unit).toBe("mg/dL");
    expect(doc.abnormalResults[1].name).toBe("HbA1c");
    expect(doc.abnormalResults[1].value).toBe("9.0");

    // Normal Results (Hemoglobin, Prothrombin Time)
    expect(doc.normalResults).toBeDefined();
    expect(doc.normalResults.length).toBe(2);
    expect(doc.normalResults[0].name).toBe("Hemoglobin");
    expect(doc.normalResults[1].name).toBe("Prothrombin Time (PT)");

    // Medical term preservation: test names are not mangled
    expect(doc.abnormalResults.some((t) => t.name.includes("સ્કૂલર"))).toBe(false);
    expect(doc.abnormalResults.some((t) => t.name.includes("ઇન્ટરનેટ"))).toBe(false);
  });

  test("4. Chat service passes repeat_penalty: 1.2 and repeat_last_n: 64 to Ollama to prevent repetition loops", async () => {
    const { chatService } = require("../src/services/ai/chat/chat.service");

    const chatSpy = jest
      .spyOn(ollamaClient, "chat")
      .mockResolvedValue("Clinical explanation without looping.");

    const messages = [{ role: "user", content: "મારા HbA1c રિપોર્ટ વિશે સમજાવો" }];
    const contextChunks = [
      {
        documentId: "doc-valjibhai-123",
        documentName: "Lab_Report.pdf",
        reportDate: "2024-08-30",
        patientName: "Valjibhai Ranoliya",
        sectionTitle: "Biochemistry",
        content: "HbA1c: 9.0%, Random Blood Sugar: 271 mg/dL",
        structuredTests: [
          {
            name: "HbA1c",
            value: "9.0",
            unit: "%",
            status: "Abnormal",
            referenceRange: "< 5.7%",
            isAbnormal: true,
          },
        ],
      },
    ];

    const res = await chatService.qwenHealthChat(
      messages,
      "DOCUMENT_RAG",
      contextChunks,
      "Patient: Valjibhai Ranoliya, Age: 70",
      "gujarati",
      "Coverage: 1 report",
    );

    expect(res.answer).toBe("Clinical explanation without looping.");
    expect(chatSpy).toHaveBeenCalledTimes(1);

    const callArgs = chatSpy.mock.calls[0];
    const callOptions = callArgs[2];

    expect(callOptions).toBeDefined();
    expect(callOptions.rawOptions).toBeDefined();
    expect(callOptions.rawOptions.repeat_penalty).toBe(1.2);
    expect(callOptions.rawOptions.repeat_last_n).toBe(64);
  });
});
