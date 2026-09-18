const documentPersistenceService = require("../../src/services/documentPersistence.service");
const { addDocumentSchema } = require("../../src/validations/documentFlowValidation");
const { medicalGraph } = require("../../src/models/documentArtifacts");

function makeTestTx(recorded = []) {
  const chain = (table) => ({
    values(v) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        recorded.push({
          table,
          data: item,
        });
      }
      return {
        onConflictDoUpdate() {
          return {
            returning: async () => [{ id: "mock_id_1" }],
          };
        },
        returning: async () => [{ id: "mock_id_1" }],
      };
    },
    set() {
      return {
        where: () => ({
          returning: async () => [{ id: "mock_id_1" }],
        }),
      };
    },
    where: () => ({
      returning: async () => [{ id: "mock_id_1" }],
    }),
  });

  return {
    insert: (table) => chain(table),
    update: (table) => chain(table),
    delete: () => ({
      where: () => ({
        returning: async () => [],
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
          orderBy: async () => [],
        }),
      }),
    }),
  };
}

describe("Medical Graphs Persistence Hardening", () => {
  const basePatient = { id: "00000000-0000-0000-0000-000000000001", patientCode: "P-1001" };

  test("addDocumentWithTx sanitizes leaked schema placeholder strings into null/valid types", async () => {
    const recorded = [];
    const tx = makeTestTx(recorded);

    const payload = {
      s3Key: "documents/pat_123/graph_test.pdf",
      rawOcrData: { fullText: "BP Chart" },
      extractedStructuredData: {
        reportDate: "2025-01-15",
        summary: "Blood pressure chart report",
      },
      graphs: [
        {
          graphType: "line-chart|bar-chart|ecg|trend|other",
          title: "string|null",
          xAxis: ["string|number, ...", "Day 1", "Day 2"],
          yAxis: ["number, ...", 120, 118],
          series: [{ name: "string|null", values: ["number, ...", 120, 118] }],
          unit: "string|null",
          page: "number|null",
          metadata: "object",
        },
      ],
      embeddingsGenerated: true,
    };

    await documentPersistenceService.addDocumentWithTx(tx, {
      userId: basePatient.id,
      payload,
      patient: basePatient,
    });

    const graphInserts = recorded.filter((r) => r.table === medicalGraph);
    expect(graphInserts.length).toBe(1);

    const saved = graphInserts[0].data;
    // Page must be strict null, never the string "number|null"
    expect(saved.page).toBeNull();
    expect(typeof saved.page).not.toBe("string");

    // Title and unit must be null, never "string|null"
    expect(saved.title).toBeNull();
    expect(saved.unit).toBeNull();

    // graphType must be sanitized from pipe unions to "unknown"
    expect(saved.graphType).toBe("unknown");

    // Axis arrays must not contain schema placeholder strings
    expect(saved.xAxis).toEqual(["Day 1", "Day 2"]);
    expect(saved.yAxis).toEqual([120, 118]);
    expect(saved.series[0].name).toBe("Series");
    expect(saved.series[0].values).toEqual([120, 118]);
    expect(saved.metadata).toEqual({});
  });

  test("addDocumentWithTx preserves valid integer page and clinical graph details", async () => {
    const recorded = [];
    const tx = makeTestTx(recorded);

    const payload = {
      s3Key: "documents/pat_123/valid_graph.pdf",
      rawOcrData: { fullText: "ECG strip" },
      extractedStructuredData: {
        reportDate: "2025-01-15",
        summary: "ECG Report",
      },
      graphs: [
        {
          graphType: "ecg",
          title: "Lead II Rhythm Strip",
          xAxis: [0, 1, 2],
          yAxis: [0.1, 0.5, -0.2],
          series: [{ name: "Lead II", values: [0.1, 0.5, -0.2] }],
          unit: "mV",
          page: 2,
          metadata: { samplingRate: 250 },
        },
      ],
      embeddingsGenerated: true,
    };

    await documentPersistenceService.addDocumentWithTx(tx, {
      userId: basePatient.id,
      payload,
      patient: basePatient,
    });

    const graphInserts = recorded.filter((r) => r.table === medicalGraph);
    expect(graphInserts.length).toBe(1);

    const saved = graphInserts[0].data;
    expect(saved.page).toBe(2);
    expect(saved.title).toBe("Lead II Rhythm Strip");
    expect(saved.unit).toBe("mV");
    expect(saved.graphType).toBe("ecg");
    expect(saved.xAxis).toEqual([0, 1, 2]);
    expect(saved.yAxis).toEqual([0.1, 0.5, -0.2]);
    expect(saved.metadata).toEqual({ samplingRate: 250 });
  });

  test("addDocumentWithTx coerces string integer page into valid integer", async () => {
    const recorded = [];
    const tx = makeTestTx(recorded);

    const payload = {
      s3Key: "documents/pat_123/string_page.pdf",
      rawOcrData: { fullText: "Lab report" },
      extractedStructuredData: { summary: "Report" },
      graphs: [
        {
          graphType: "trend",
          page: "5",
        },
      ],
      embeddingsGenerated: true,
    };

    await documentPersistenceService.addDocumentWithTx(tx, {
      userId: basePatient.id,
      payload,
      patient: basePatient,
    });

    const graphInserts = recorded.filter((r) => r.table === medicalGraph);
    expect(graphInserts.length).toBe(1);
    expect(graphInserts[0].data.page).toBe(5);
  });

  test("addDocumentSchema transforms placeholder strings safely during validation", () => {
    const rawPayload = {
      s3Key: "documents/pat_123/test.pdf",
      graphs: [
        {
          graphType: "line-chart|bar-chart",
          title: "string|null",
          page: "number|null",
          unit: "string|null",
        },
      ],
    };

    const validated = addDocumentSchema.parse(rawPayload);
    expect(validated.graphs[0].page).toBeNull();
    expect(validated.graphs[0].title).toBeNull();
    expect(validated.graphs[0].unit).toBeNull();
    expect(validated.graphs[0].graphType).toBe("unknown");
  });
});
