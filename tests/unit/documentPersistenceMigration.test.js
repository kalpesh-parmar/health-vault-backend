const documentPersistenceService = require("../../src/services/documentPersistence.service");
const { buildStructuredReportPayload } = require("../../src/helpers/reportPayload.helper");

function makeTrackingTx(recorded = {}) {
  recorded.documentInserts = [];
  recorded.documentUpdates = [];
  recorded.aiSummaryInserts = [];
  recorded.aiSummaryUpdates = [];

  const chain = (table) => ({
    values(v) {
      if (table?.documentId && !table?.s3Key) {
        recorded.aiSummaryInserts.push(v);
      } else if (table?.s3Key) {
        recorded.documentInserts.push(v);
      }
      return {
        onConflictDoUpdate({ set }) {
          if (table?.documentId && !table?.s3Key) {
            recorded.aiSummaryUpdates.push(set);
          } else if (table?.s3Key) {
            recorded.documentUpdates.push(set);
          }
          return {
            returning: async () => [{ id: "doc_test_123" }],
          };
        },
        returning: async () => [{ id: "doc_test_123" }],
      };
    },
    set(v) {
      if (table?.documentId && !table?.s3Key) {
        recorded.aiSummaryUpdates.push(v);
      } else if (table?.s3Key) {
        recorded.documentUpdates.push(v);
      }
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

describe("Phase 11 Unified Persistence & Migration Verification", () => {
  test("savePipelineArtifacts persists 14 sections canonically and enforces strict projections without fallback to current date", async () => {
    const recorded = {};
    const tx = makeTrackingTx(recorded);

    const canonical14Sections = {
      documentInfo: { documentType: "QUOTATION", documentDate: null },
      patientInfo: { fullName: "Manjuben Ranoliya", age: 52, gender: "FEMALE", dateOfBirth: null },
      providerInfo: {
        primary: { name: "Dr. Hardik Suvagiya", specialty: "Implantologist" },
        providers: [
          { name: "Dr. Hardik Suvagiya", isPrimary: true },
          { name: "Dr. Kinnari Markana", isPrimary: false },
        ],
      },
      facilityInfo: { name: "dente 32 DENTAL CARE" },
      diagnosis: [],
      symptoms: [],
      vitals: [],
      labResults: [],
      medications: [],
      procedures: [],
      treatments: [
        { name: "Dental Implants", quantity: 12 },
        { name: "DMLS Teeth", quantity: 24 },
      ],
      treatmentPlan: { phases: [{ phase: 1 }, { phase: 2 }] },
      financialSummary: {
        mandatoryTotal: 420000.0,
        optionalTotal: 28000.0,
        estimatedTotal: 420000.0,
        lineItems: [
          { description: "Implants", totalPrice: 240000.0, isOptional: false },
          { description: "Teeth", totalPrice: 180000.0, isOptional: false },
          { description: "Guide", totalPrice: 18000.0, isOptional: true },
          { description: "Graft", totalPrice: 10000.0, isOptional: true },
        ],
      },
      additionalInformation: { notes: "Quotation valid for 30 days" },
    };

    const payload = {
      s3Key: "documents/user_456/quotation.pdf",
      rawOcrData: { fullText: "Sample dental quotation" },
      extractedStructuredData: canonical14Sections,
      embeddingsGenerated: true,
      skipMedications: true,
    };

    await documentPersistenceService.addDocumentWithTx(tx, {
      userId: "user_456",
      payload,
      patient: { id: "pat_123", patientCode: "P-1001" },
    });

    // 1. Document update verification
    expect(recorded.documentInserts.length).toBeGreaterThan(0);
    const docInsert = recorded.documentInserts[0];

    // Canonical source of truth preserved
    expect(docInsert.structuredExtractedData).toEqual(canonical14Sections);

    // Strict projection: hospitalName from facilityInfo
    expect(docInsert.hospitalName).toBe("dente 32 DENTAL CARE");

    // Strict projection: doctorName from providerInfo.primary
    expect(docInsert.doctorName).toBe("Dr. Hardik Suvagiya");

    // Strict projection: reportDate is null when documentDate is null (NEVER fallback to current date!)
    expect(docInsert.reportDate).toBeNull();

    // 2. document_ai_summary verification - zero duplicate clinical columns written!
    expect(recorded.aiSummaryInserts.length).toBeGreaterThan(0);
    const summaryInsert = recorded.aiSummaryInserts[0];

    // Audit metadata present
    expect(summaryInsert.documentId).toBe("doc_test_123");
    expect(summaryInsert.userId).toBe("user_456");

    // Redundant duplicate clinical columns MUST NOT be present
    expect(summaryInsert.diagnosis).toBeUndefined();
    expect(summaryInsert.medications).toBeUndefined();
    expect(summaryInsert.labResults).toBeUndefined();
    expect(summaryInsert.vitals).toBeUndefined();
    expect(summaryInsert.doctorName).toBeUndefined();
    expect(summaryInsert.hospitalName).toBeUndefined();
    expect(summaryInsert.patientName).toBeUndefined();
    expect(summaryInsert.patientAge).toBeUndefined();
  });

  test("Doctor projection is null when multiple providers exist and none is marked primary", async () => {
    const recorded = {};
    const tx = makeTrackingTx(recorded);

    const dataWithIndeterminateDoctor = {
      documentInfo: { documentType: "LAB_REPORT" },
      patientInfo: { fullName: "Test Patient" },
      providerInfo: {
        primary: null,
        providers: [
          { name: "Dr. Alice", isPrimary: false },
          { name: "Dr. Bob", isPrimary: false },
        ],
      },
      facilityInfo: { name: "PathLab" },
    };

    await documentPersistenceService.addDocumentWithTx(tx, {
      userId: "user_456",
      payload: {
        s3Key: "documents/user_456/indeterminate.pdf",
        rawOcrData: { fullText: "Lab report" },
        extractedStructuredData: dataWithIndeterminateDoctor,
        embeddingsGenerated: true,
        skipMedications: true,
      },
      patient: { id: "pat_123", patientCode: "P-1001" },
    });

    const docInsert = recorded.documentInserts[0];
    // Doctor name MUST be null rather than arbitrarily selecting Dr. Alice or concatenating
    expect(docInsert.doctorName).toBeNull();
  });

  test("buildStructuredReportPayload adapts canonical 14 sections, formats quotation, and exposes provider/facility/financial info", async () => {
    const mockDoc = {
      id: "doc_quote_1",
      fileName: "Manjuben Ranoliya.pdf",
      documentType: "QUOTATION",
      reportDate: null,
      hospitalName: "dente 32",
      doctorName: "Dr. Hardik Suvagiya",
      structuredExtractedData: {
        documentInfo: { documentType: "QUOTATION" },
        patientInfo: { fullName: "Manjuben Ranoliya", age: 52, gender: "FEMALE" },
        providerInfo: {
          primary: { name: "Dr. Hardik Suvagiya" },
          providers: [
            { name: "Dr. Hardik Suvagiya", isPrimary: true },
            { name: "Dr. Kinnari Markana" },
          ],
        },
        facilityInfo: { name: "dente 32" },
        financialSummary: {
          mandatoryTotal: 420000.0,
          optionalTotal: 28000.0,
          estimatedTotal: 420000.0,
          lineItems: [{ description: "Implants", totalPrice: 240000.0 }],
        },
        treatments: [{ name: "All-on-6 Implants", quantity: 12 }],
        treatmentPlan: { phases: [{ phaseNumber: 1, phaseName: "Surgical" }] },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord: mockDoc,
      preferredLanguage: "english",
    });

    expect(payload.action).toBe("ASK_REPORT");
    expect(payload.document.isQuotation).toBe(true);
    expect(payload.document.isLabReport).toBe(false);
    expect(payload.document.doctorName).toBe("Dr. Hardik Suvagiya");
    expect(payload.document.hospitalName).toBe("dente 32");
    expect(payload.document.patientDetails.name).toBe("Manjuben Ranoliya");
    expect(payload.document.financialSummary.mandatoryTotal).toBe(420000.0);
    expect(payload.document.financialSummary.optionalTotal).toBe(28000.0);
    expect(payload.document.treatments.length).toBe(1);
    expect(payload.document.treatmentPlan.phases.length).toBe(1);
  });
});
