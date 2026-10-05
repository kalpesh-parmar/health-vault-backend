const {
  buildStructuredReportPayload,
  PIPELINE_VERSION,
} = require("../../src/helpers/reportPayload.helper");
const aiClient = require("../../src/services/ai/clients/aiClient.service");

jest.mock("../../src/services/ai/clients/aiClient.service");
jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve([])),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve()),
      })),
    })),
  },
}));

describe("Commit A Contract - Report Payload Summary Plumbing & Stub Guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("stub guard blocks translation for generic stub summary and sets translationStatus to summary_unavailable", async () => {
    const docRecord = {
      id: "doc-123",
      fileName: "lab.pdf",
      documentType: "LAB_REPORT",
      summaryEnglish: "Medical laboratory report summary.",
      structuredExtractedData: {
        patientInfo: { name: "Ramesh Patel" },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord,
      preferredLanguage: "gujarati",
    });

    expect(aiClient.translate).not.toHaveBeenCalled();
    expect(payload.document.translationStatus).toBe("summary_unavailable");
    expect(payload.document.summary).toBe("Medical laboratory report summary.");
  });

  test("stub guard blocks translation for short (< 80 chars) English summary", async () => {
    const docRecord = {
      id: "doc-124",
      fileName: "lab.pdf",
      documentType: "LAB_REPORT",
      summaryEnglish: "Normal CBC test report. Everything looks fine.", // < 80 chars
      structuredExtractedData: {
        patientInfo: { name: "Ramesh Patel" },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord,
      preferredLanguage: "gujarati",
    });

    expect(aiClient.translate).not.toHaveBeenCalled();
    expect(payload.document.translationStatus).toBe("summary_unavailable");
  });

  test("long valid English summary (> 80 chars) translates and sets translationStatus to translated", async () => {
    const validLongEnglish =
      "The patient presents with normal complete blood count parameters with hemoglobin at 13.5 g/dL and normal platelets.";
    const validGujaratiTranslation =
      "દર્દી સામાન્ય સંપૂર્ણ રક્ત ગણતરી પરિમાણો રજૂ કરે છે જેમાં હિમોગ્લોબિન 13.5 g/dL છે.";

    aiClient.translate.mockResolvedValueOnce(validGujaratiTranslation);

    const docRecord = {
      id: "doc-125",
      fileName: "lab.pdf",
      documentType: "LAB_REPORT",
      summaryEnglish: validLongEnglish,
      structuredExtractedData: {
        patientInfo: { name: "Ramesh Patel" },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord,
      preferredLanguage: "gujarati",
    });

    expect(aiClient.translate).toHaveBeenCalledWith(validLongEnglish, "english", "gujarati");
    expect(payload.document.translationStatus).toBe("translated");
    expect(payload.document.summary).toBe(validGujaratiTranslation);
  });

  test("cache hit with matching PIPELINE_VERSION returns cached translation without re-translating", async () => {
    const cachedGujarati = "દર્દી સામાન્ય સંપૂર્ણ રક્ત ગણતરી પરિમાણો ધરાવે છે.";
    const docRecord = {
      id: "doc-126",
      fileName: "lab.pdf",
      documentType: "LAB_REPORT",
      summaryEnglish:
        "The patient presents with normal complete blood count parameters with hemoglobin at 13.5 g/dL and normal platelets.",
      structuredExtractedData: {
        patientInfo: { name: "Ramesh Patel" },
        summaryPipelineVersion: PIPELINE_VERSION,
        summariesByLanguage: {
          gujarati: cachedGujarati,
        },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord,
      preferredLanguage: "gujarati",
    });

    expect(aiClient.translate).not.toHaveBeenCalled();
    expect(payload.document.translationStatus).toBe("cached");
    expect(payload.document.summary).toBe(cachedGujarati);
  });

  test("cache invalidation: stale PIPELINE_VERSION triggers re-translation", async () => {
    const staleGujarati = "જૂનો અમાન્ય સારાંશ જે અમાન્ય છે.";
    const validLongEnglish =
      "The patient presents with normal complete blood count parameters with hemoglobin at 13.5 g/dL and normal platelets.";
    const freshGujarati = "તાજો અને સચોટ અનુવાદ સારાંશ.";

    aiClient.translate.mockResolvedValueOnce(freshGujarati);

    const docRecord = {
      id: "doc-127",
      fileName: "lab.pdf",
      documentType: "LAB_REPORT",
      summaryEnglish: validLongEnglish,
      structuredExtractedData: {
        patientInfo: { name: "Ramesh Patel" },
        summaryPipelineVersion: "0.8.0", // Outdated version
        summariesByLanguage: {
          gujarati: staleGujarati,
        },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord,
      preferredLanguage: "gujarati",
    });

    expect(aiClient.translate).toHaveBeenCalledWith(validLongEnglish, "english", "gujarati");
    expect(payload.document.translationStatus).toBe("translated");
    expect(payload.document.summary).toBe(freshGujarati);
  });
});
