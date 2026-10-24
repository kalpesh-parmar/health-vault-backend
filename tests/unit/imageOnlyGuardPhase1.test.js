const { buildStructuredReportPayload } = require("../../src/helpers/reportPayload.helper");
const { extractKeyPoints } = require("../../src/helpers/summary.helper");
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

describe("Phase 1 Backend Guard - Image-Only Skull X-Ray Fixture", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createSkullXrayFixture = () => ({
    id: "doc-skull-xray-001",
    fileName: "skull_xray.jpg",
    documentType: "IMAGING_REPORT",
    subType: "image_only_radiograph",
    isNoText: true,
    summaryEnglish:
      "**Skull X-Ray Imaging Analysis**\n\n• Calvarial vault intact.\n• No acute depressed fracture.\n* * *",
    summaryInPreferredLanguage: "આ ખોપરીનો એક્સ-રે છે. કોઈ સ્પષ્ટ અસ્થિભંગ દેખાતું નથી.",
    structuredExtractedData: {
      isNoText: true,
      documentType: "IMAGING_REPORT",
      subType: "image_only_radiograph",
      summaryEnglish:
        "**Skull X-Ray Imaging Analysis**\n\n• Calvarial vault intact.\n• No acute depressed fracture.\n* * *",
      summaryInPreferredLanguage: "આ ખોપરીનો એક્સ-રે છે. કોઈ સ્પષ્ટ અસ્થિભંગ દેખાતું નથી.",
      keyPoints: ["**Skull X-Ray Imaging Analysis**", "• Calvarial vault intact.", "* * *"],
      imageAnalysis: {
        status: "UNVERIFIED_PRELIMINARY",
        modality: "x_ray",
        anatomicalRegion: "skull",
        clinicallyAnalyzed: false,
        requiresClinicianReview: true,
      },
      patientInfo: { fullName: "Ramesh Patel" },
      diagnosis: [],
      labResults: [],
      medications: [],
    },
  });

  test("summary.helper extractKeyPoints returns [] for image-only document", () => {
    const fixture = createSkullXrayFixture();
    const points = extractKeyPoints(
      fixture.structuredExtractedData,
      fixture.structuredExtractedData.summaryEnglish,
      "en",
    );
    expect(points).toEqual([]);
  });

  test("buildStructuredReportPayload enforces empty keyPoints, empty keyFindings, empty whatThisMayMean, and skips translation for Gujarati profile", async () => {
    const fixture = createSkullXrayFixture();

    const payload = await buildStructuredReportPayload({
      docRecord: fixture,
      preferredLanguage: "gujarati",
    });

    const doc = payload.document;

    // 1. Translation service must NOT be called
    expect(aiClient.translate).not.toHaveBeenCalled();

    // 2. Clinical findings must remain strictly empty
    expect(doc.keyPoints).toEqual([]);
    expect(doc.keyFindings).toEqual([]);
    expect(doc.whatThisMayMean).toBe("");

    // 3. Fallback disclosure populated cleanly
    expect(doc.isNoText).toBe(true);
    expect(doc.summary).toBeTruthy();
    expect(typeof doc.summary).toBe("string");

    // 4. Assert NO asterisks or markdown bullets in any string field
    const assertNoAsterisks = (obj, path = "") => {
      if (!obj) return;
      if (typeof obj === "string") {
        expect(obj).not.toContain("*");
      } else if (Array.isArray(obj)) {
        obj.forEach((item, idx) => assertNoAsterisks(item, `${path}[${idx}]`));
      } else if (typeof obj === "object") {
        for (const [key, val] of Object.entries(obj)) {
          // Skip raw imageAnalysis debug fields if present
          if (key === "rawImageAnalysis" || key === "rawOutput") continue;
          assertNoAsterisks(val, `${path}.${key}`);
        }
      }
    };

    assertNoAsterisks({
      summary: doc.summary,
      keyPoints: doc.keyPoints,
      keyFindings: doc.keyFindings,
      whatThisMayMean: doc.whatThisMayMean,
    });
  });

  test("buildStructuredReportPayload also guards when isNoText is in additionalInformation", async () => {
    const fixture = {
      id: "doc-legacy-addl-info",
      fileName: "xray.jpg",
      documentType: "IMAGING_REPORT",
      structuredExtractedData: {
        additionalInformation: { isNoText: true },
        summaryEnglish: "**Chest X-Ray**\n\n• Heart size normal.\n* * *",
        patientInfo: { name: "Anand Kumar" },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord: fixture,
      preferredLanguage: "english",
    });

    const doc = payload.document;
    expect(aiClient.translate).not.toHaveBeenCalled();
    expect(doc.keyPoints).toEqual([]);
    expect(doc.keyFindings).toEqual([]);
    expect(doc.whatThisMayMean).toBe("");
    expect(doc.isNoText).toBe(true);
    expect(doc.summary).not.toContain("*");
  });
});
