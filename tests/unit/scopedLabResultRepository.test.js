const { patientLabResultRepository } = require("../../src/repositories/patientLabResultRepository");
const { medicalFactLookupService } = require("../../src/services/medicalFactLookup.service");
const { medicalTrendChartService } = require("../../src/services/medicalTrendChart.service");

// Mock drizzle db
jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn(),
  },
}));

const { db } = require("../../src/configs/db");

describe("Phase 2 - Scoped SQL, Fact Lookup and Chart Retrieval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("patientLabResultRepository.findByCanonicalKey", () => {
    it("applies documentIds filter when provided", async () => {
      const mockLimit = jest
        .fn()
        .mockResolvedValue([
          { id: "obs-1", documentId: "doc-A", canonicalKey: "hemoglobin", valueNumeric: 14.2 },
        ]);
      const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
      const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
      db.select.mockReturnValue({ from: mockFrom });

      const results = await patientLabResultRepository.findByCanonicalKey("pat-123", "hemoglobin", {
        documentIds: ["doc-A"],
      });

      expect(db.select).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("doc-A");
    });

    it("queries without documentIds when omitted (lifetime history)", async () => {
      const mockLimit = jest.fn().mockResolvedValue([
        { id: "obs-1", documentId: "doc-A", canonicalKey: "hemoglobin", valueNumeric: 14.2 },
        { id: "obs-2", documentId: "doc-B", canonicalKey: "hemoglobin", valueNumeric: 11.5 },
      ]);
      const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
      const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
      db.select.mockReturnValue({ from: mockFrom });

      const results = await patientLabResultRepository.findByCanonicalKey("pat-123", "hemoglobin");

      expect(results).toHaveLength(2);
    });
  });

  describe("patientLabResultRepository.aggregateByPeriod", () => {
    it("applies documentIds filter when provided to trend query", async () => {
      const mockWhere = jest.fn().mockReturnValue({
        groupBy: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockResolvedValue([
            {
              id: "obs-1",
              documentId: "doc-A",
              canonicalKey: "hemoglobin",
              valueNumeric: 14.2,
              effectiveDateTime: new Date("2025-01-15"),
              unit: "g/dL",
              referenceRangeLow: 13.0,
              referenceRangeHigh: 17.0,
              abnormalFlag: "NORMAL",
            },
          ]),
        }),
      });
      const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
      db.select.mockReturnValue({ from: mockFrom });

      const results = await patientLabResultRepository.aggregateByPeriod(
        "pat-123",
        "hemoglobin",
        "1y",
        { documentIds: ["doc-A"] },
      );

      expect(db.select).toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("doc-A");
    });
  });

  describe("medicalFactLookupService.lookupFact", () => {
    it("passes documentIds to repository search", async () => {
      const spy = jest.spyOn(patientLabResultRepository, "findByCanonicalKey").mockResolvedValue([
        {
          id: "obs-1",
          documentId: "doc-A",
          canonicalKey: "glucose_fasting",
          testName: "Fasting Blood Glucose",
          valueNumeric: 95,
          unit: "mg/dL",
          effectiveDateTime: new Date("2025-01-10"),
          abnormalFlag: "NORMAL",
          referenceRangeLow: 70,
          referenceRangeHigh: 100,
        },
      ]);

      const fact = await medicalFactLookupService.lookupFact("pat-123", "What is my blood sugar?", {
        documentIds: ["doc-A"],
      });

      expect(spy).toHaveBeenCalledWith(
        "pat-123",
        expect.any(String),
        expect.objectContaining({ documentIds: ["doc-A"] }),
      );
      expect(fact.results).toHaveLength(1);
      expect(fact.latest.valueNumeric).toBe(95);

      spy.mockRestore();
    });
  });

  describe("medicalTrendChartService.generateTrendChart", () => {
    it("restricts chart generation to specified documentIds", async () => {
      const spy = jest.spyOn(patientLabResultRepository, "findByCanonicalKey").mockResolvedValue([
        {
          id: "obs-1",
          documentId: "doc-A",
          canonicalKey: "hemoglobin",
          testName: "Hemoglobin",
          valueNumeric: 13.5,
          unit: "g/dL",
          effectiveDateTime: new Date("2025-01-01"),
          referenceRangeLow: 12.0,
          referenceRangeHigh: 16.0,
          abnormalFlag: "NORMAL",
        },
      ]);

      const chartResult = await medicalTrendChartService.generateTrendChart({
        userId: "pat-123",
        canonicalKey: "hemoglobin",
        documentIds: ["doc-A"],
        scopeMode: "SINGLE_DOCUMENT",
      });

      expect(spy).toHaveBeenCalledWith(
        "pat-123",
        "hemoglobin",
        expect.objectContaining({ documentIds: ["doc-A"] }),
      );
      expect(chartResult).not.toBeNull();
      expect(chartResult.hasData).toBe(true);
      expect(chartResult.chart.points).toHaveLength(1);
      expect(chartResult.chart.points[0].documentId).toBe("doc-A");

      spy.mockRestore();
    });
  });
});
