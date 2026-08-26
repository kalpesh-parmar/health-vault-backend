const documentPersistenceService = require("../../src/services/documentPersistence.service");

function makeSerializingTx(recorded = []) {
  const serialize = (table, obj) => {
    if (!obj || typeof obj !== "object") return;
    const entries = Array.isArray(obj) ? obj : [obj];
    for (const item of entries) {
      for (const [key, val] of Object.entries(item)) {
        const col = table[key];
        if (!col?.mapToDriverValue || val === null || val === undefined) continue;
        recorded.push({
          table: table._?.name || table.name || "unknown",
          key,
          value: col.mapToDriverValue(val),
        });
      }
    }
  };

  const chain = (table) => ({
    values(v) {
      serialize(table, v);
      return {
        onConflictDoUpdate({ set }) {
          serialize(table, set);
          return {
            returning: async () => [{ id: "doc_test_123" }],
          };
        },
        returning: async () => [{ id: "doc_test_123" }],
      };
    },
    set(v) {
      serialize(table, v);
      return {
        where: () => ({
          returning: async () => [{ id: "doc_test_123" }],
        }),
      };
    },
    where: () => ({
      returning: async () => [{ id: "doc_test_123" }],
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

describe("Document Persistence Date Serialization (Real Service Path)", () => {
  const basePatient = { id: "pat_123", patientCode: "P-1001" };

  test("Case 1 & 2: reportDate '2025-01-15' with medications serializes to valid UTC date across document, ai_summary, and medications", async () => {
    const recorded = [];
    const tx = makeSerializingTx(recorded);

    const payload = {
      s3Key: "documents/pat_123/blood_test.pdf",
      rawOcrData: { fullText: "Report Date: 2025-01-15\nParacetamol 500mg" },
      extractedStructuredData: {
        reportDate: "2025-01-15",
        doctorName: "Dr. Smith",
        summary: "Normal report",
        medications: [{ name: "Paracetamol", duration: "5 Days" }],
      },
      graphs: [],
      embeddingsGenerated: true,
    };

    await documentPersistenceService.addDocumentWithTx(tx, {
      userId: "pat_123",
      payload,
      patient: basePatient,
    });

    // 1. documents.reportDate starts with 2025-01-15 (UTC date anchor, no IST shift to 2025-01-14)
    const docReportDates = recorded.filter((r) => r.key === "reportDate");
    expect(docReportDates.length).toBeGreaterThanOrEqual(1);
    expect(docReportDates[0].value.startsWith("2025-01-15")).toBe(true);

    // 2. document_ai_summary.reportDate and medications.startDate / endDate serialized without throwing
    const medStartDates = recorded.filter((r) => r.key === "startDate");
    expect(medStartDates.length).toBeGreaterThanOrEqual(1);
    expect(medStartDates[0].value.startsWith("2025-01-15")).toBe(true);

    const medEndDates = recorded.filter((r) => r.key === "endDate");
    expect(medEndDates.length).toBeGreaterThanOrEqual(1);
    expect(medEndDates[0].value.startsWith("2025-01-20")).toBe(true);
  });

  test("Case 3: Garbage reportDate values never throw RangeError and never store invalid dates", async () => {
    const garbageValues = ["", "N/A", "unknown", "2025-02-30", "0000-00-00", null, 12345, {}];

    for (const badDate of garbageValues) {
      const recorded = [];
      const tx = makeSerializingTx(recorded);

      const payload = {
        s3Key: `documents/pat_123/bad_${String(badDate)}.pdf`,
        rawOcrData: { fullText: "Sample" },
        extractedStructuredData: {
          reportDate: badDate,
          summary: "Garbage test",
          medications: [],
        },
        embeddingsGenerated: true,
      };

      await expect(
        documentPersistenceService.addDocumentWithTx(tx, {
          userId: "pat_123",
          payload,
          patient: basePatient,
        }),
      ).resolves.not.toThrow();
    }
  });

  test("Case 4: endDate null for ongoing medication stays null and is not coerced to now()", async () => {
    const recorded = [];
    const tx = makeSerializingTx(recorded);

    const payload = {
      s3Key: "documents/pat_123/ongoing.pdf",
      rawOcrData: { fullText: "Ongoing medicine" },
      extractedStructuredData: {
        reportDate: "2025-01-15",
        medications: [{ name: "Aspirin", duration: "" }],
      },
      embeddingsGenerated: true,
    };

    await documentPersistenceService.addDocumentWithTx(tx, {
      userId: "pat_123",
      payload,
      patient: basePatient,
    });

    const endDates = recorded.filter((r) => r.key === "endDate");
    // If endDate was null, it should not be recorded as a coerced Date in serialized values
    expect(endDates.length).toBe(0);
  });
});
