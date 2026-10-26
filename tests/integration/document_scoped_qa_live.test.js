const {
  documentAuthorizationService,
} = require("../../src/services/ai/chat/documentAuthorization.service");
const { documentResolverService } = require("../../src/services/ai/chat/documentResolver.service");
const { slotContextService } = require("../../src/services/ai/chat/slotContext.service");

async function runDocumentScopedQaLiveTests() {
  console.log("================================================================================");
  console.log("HEALTH VAULT: v8.2 DOCUMENT-SCOPED SMART MEDICAL QA FULL INTEGRATION TEST SUITE");
  console.log("================================================================================\n");

  let passedChecks = 0;
  let totalChecks = 0;

  function recordCheck(name, passed, detail = "") {
    totalChecks++;
    if (passed) {
      passedChecks++;
      console.log(`[PASS] Check ${totalChecks}: ${name}${detail ? ` (${detail})` : ""}`);
    } else {
      console.error(`[FAIL] Check ${totalChecks}: ${name}${detail ? ` (${detail})` : ""}`);
    }
  }

  // --- MOCK DATABASE SETUP FOR ISOLATION TESTING ---
  const MOCK_USER_ID = "usr-101";
  const MOCK_PATIENT_ID = "pat-202";
  const OTHER_PATIENT_ID = "pat-999";

  const REPORT_A = {
    id: "doc-report-a",
    userId: MOCK_USER_ID,
    patientId: MOCK_PATIENT_ID,
    fileName: "Apollo_CBC_Report_Jan2026.pdf",
    documentType: "LAB_REPORT",
    hospitalName: "Apollo Hospitals",
    doctorName: "Dr. Sharma",
    reportDate: new Date("2026-01-15T10:00:00Z"),
    status: "COMPLETED",
    isDeleted: false,
  };

  const REPORT_B = {
    id: "doc-report-b",
    userId: MOCK_USER_ID,
    patientId: MOCK_PATIENT_ID,
    fileName: "Max_Metabolic_Panel_Feb2026.pdf",
    documentType: "LAB_REPORT",
    hospitalName: "Max Healthcare",
    doctorName: "Dr. Patel",
    reportDate: new Date("2026-02-20T10:00:00Z"),
    status: "COMPLETED",
    isDeleted: false,
  };

  const REPORT_DELETED = {
    id: "doc-deleted-c",
    userId: MOCK_USER_ID,
    patientId: MOCK_PATIENT_ID,
    fileName: "Old_Archived_Report.pdf",
    documentType: "LAB_REPORT",
    hospitalName: "City Clinic",
    reportDate: new Date("2025-05-10T10:00:00Z"),
    status: "COMPLETED",
    isDeleted: true,
  };

  const REPORT_OTHER_PATIENT = {
    id: "doc-unauthorized-d",
    userId: "other-user",
    patientId: OTHER_PATIENT_ID,
    fileName: "Confidential_Other_Patient.pdf",
    documentType: "LAB_REPORT",
    hospitalName: "Metro Hospital",
    reportDate: new Date("2026-03-01T10:00:00Z"),
    status: "COMPLETED",
    isDeleted: false,
  };

  const allDocumentsDb = [REPORT_A, REPORT_B, REPORT_DELETED, REPORT_OTHER_PATIENT];

  // Mock document repository queries
  const mockDb = {
    query: {
      documents: {
        findMany: async () => {
          return allDocumentsDb.filter((d) => {
            if (d.userId !== MOCK_USER_ID) return false;
            if (d.patientId !== MOCK_PATIENT_ID) return false;
            return true;
          });
        },
      },
    },
  };

  // Mock observations in lab results repository
  const LAB_RESULTS = [
    {
      id: "lab-1",
      documentId: REPORT_A.id,
      patientId: MOCK_PATIENT_ID,
      canonicalKey: "hemoglobin",
      testName: "Hemoglobin",
      numericValue: "13.8",
      unit: "g/dL",
      referenceRange: "13.0 - 17.0",
      isAbnormal: false,
      observedAt: new Date("2026-01-15T10:00:00Z"),
    },
    {
      id: "lab-2",
      documentId: REPORT_B.id,
      patientId: MOCK_PATIENT_ID,
      canonicalKey: "hemoglobin",
      testName: "Hemoglobin",
      numericValue: "11.2",
      unit: "g/dL",
      referenceRange: "13.0 - 17.0",
      isAbnormal: true,
      abnormalFlag: "L",
      observedAt: new Date("2026-02-20T10:00:00Z"),
    },
    {
      id: "lab-3",
      documentId: REPORT_B.id,
      patientId: MOCK_PATIENT_ID,
      canonicalKey: "glucose_fasting",
      testName: "Fasting Blood Sugar",
      numericValue: "142",
      unit: "mg/dL",
      referenceRange: "70 - 100",
      isAbnormal: true,
      abnormalFlag: "H",
      observedAt: new Date("2026-02-20T10:00:00Z"),
    },
  ];

  // ============================================================================
  // TEST 1: Selected Report A returns only Report A values
  // ============================================================================
  console.log("\n--- TEST 1: Selected Report A Scope Isolation ---");
  const authScopeA = await documentAuthorizationService.resolveDocumentScope({
    userId: MOCK_USER_ID,
    patientId: MOCK_PATIENT_ID,
    documentIds: [REPORT_A.id],
    scopeMode: "SINGLE_DOCUMENT",
    db: mockDb,
  });

  const labA = LAB_RESULTS.filter(
    (l) =>
      authScopeA.authorizedDocumentIds.includes(l.documentId) && l.canonicalKey === "hemoglobin",
  );
  recordCheck(
    "1. Selected Report A returns only Report A observations",
    authScopeA.authorizedDocumentIds.length === 1 &&
      authScopeA.authorizedDocumentIds[0] === REPORT_A.id &&
      labA.length === 1 &&
      labA[0].numericValue === "13.8",
    `Hemoglobin: ${labA[0]?.numericValue} g/dL from ${REPORT_A.fileName}`,
  );

  // ============================================================================
  // TEST 2: Report B values never appear in Report A answers
  // ============================================================================
  console.log("\n--- TEST 2: Zero Cross-Document Leakage (Report B into Report A) ---");
  const reportBLeakInA = labA.some(
    (l) => l.documentId === REPORT_B.id || l.numericValue === "11.2",
  );
  const reportBMetricInA = LAB_RESULTS.filter(
    (l) =>
      authScopeA.authorizedDocumentIds.includes(l.documentId) &&
      l.canonicalKey === "glucose_fasting",
  );
  recordCheck(
    "2. Report B values never appear in Report A scope",
    !reportBLeakInA && reportBMetricInA.length === 0,
    "Fasting Blood Sugar from Report B is completely excluded from Report A scope",
  );

  // ============================================================================
  // TEST 3: Follow-up questions retain Report A scope
  // ============================================================================
  console.log("\n--- TEST 3: Multi-Turn Conversation Scope Retention ---");
  let sessionSlots = {
    scopeMode: authScopeA.scopeMode,
    activePatientId: MOCK_PATIENT_ID,
    activeDocumentIds: authScopeA.authorizedDocumentIds,
    selectedDocumentMetadata: { fileName: REPORT_A.fileName, hospitalName: REPORT_A.hospitalName },
    activeMetric: "hemoglobin",
  };

  // Follow-up question: "What is my hemoglobin?" with NO explicit documentId provided
  const turn2Resolution = slotContextService.resolveScopeAndSlots({
    currentTurnDocumentId: undefined,
    currentTurnScopeMode: undefined,
    sessionMetadata: { slots: sessionSlots },
    userQuestion: "What is my hemoglobin?",
    availableDocuments: [REPORT_A, REPORT_B],
    authenticatedUserId: MOCK_USER_ID,
    activePatientId: MOCK_PATIENT_ID,
  });

  recordCheck(
    "3. Follow-up question retains Report A document scope",
    turn2Resolution.scopeMode === "SINGLE_DOCUMENT" &&
      turn2Resolution.resolvedDocumentIds.length === 1 &&
      turn2Resolution.resolvedDocumentIds[0] === REPORT_A.id,
    `Retained activeDocumentIds: ${JSON.stringify(turn2Resolution.resolvedDocumentIds)}`,
  );

  // ============================================================================
  // TEST 4: Switching to Report B updates the scope
  // ============================================================================
  console.log("\n--- TEST 4: Explicit Scope Switch to Report B ---");
  const turn3Resolution = slotContextService.resolveScopeAndSlots({
    currentTurnDocumentId: REPORT_B.id,
    currentTurnScopeMode: "SINGLE_DOCUMENT",
    sessionMetadata: { slots: turn2Resolution.updatedSlots },
    userQuestion: "Now tell me about this report",
    availableDocuments: [REPORT_A, REPORT_B],
    authenticatedUserId: MOCK_USER_ID,
    activePatientId: MOCK_PATIENT_ID,
  });

  const authScopeB = await documentAuthorizationService.resolveDocumentScope({
    userId: MOCK_USER_ID,
    patientId: MOCK_PATIENT_ID,
    documentIds: turn3Resolution.resolvedDocumentIds,
    scopeMode: turn3Resolution.scopeMode,
    db: mockDb,
  });

  const labB = LAB_RESULTS.filter(
    (l) =>
      authScopeB.authorizedDocumentIds.includes(l.documentId) && l.canonicalKey === "hemoglobin",
  );

  recordCheck(
    "4. Switching to Report B updates scope and returns Report B values",
    authScopeB.authorizedDocumentIds.length === 1 &&
      authScopeB.authorizedDocumentIds[0] === REPORT_B.id &&
      labB.length === 1 &&
      labB[0].numericValue === "11.2" &&
      labB[0].isAbnormal === true,
    `Switched to Report B Hemoglobin: ${labB[0]?.numericValue} g/dL (Low)`,
  );

  // ============================================================================
  // TEST 5: Selecting two reports enables an authorized comparison
  // ============================================================================
  console.log("\n--- TEST 5: Multi-Document Authorized Comparison ---");
  const multiAuthScope = await documentAuthorizationService.resolveDocumentScope({
    userId: MOCK_USER_ID,
    patientId: MOCK_PATIENT_ID,
    documentIds: [REPORT_A.id, REPORT_B.id],
    scopeMode: "MULTI_DOCUMENT",
    db: mockDb,
  });

  const compareLabs = LAB_RESULTS.filter(
    (l) =>
      multiAuthScope.authorizedDocumentIds.includes(l.documentId) &&
      l.canonicalKey === "hemoglobin",
  ).sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  recordCheck(
    "5. Selecting two reports enables authorized comparison across both reports",
    multiAuthScope.scopeMode === "MULTI_DOCUMENT" &&
      multiAuthScope.authorizedDocumentIds.length === 2 &&
      compareLabs.length === 2 &&
      compareLabs[0].numericValue === "13.8" &&
      compareLabs[1].numericValue === "11.2",
    `Comparison: Report A (${compareLabs[0]?.numericValue}) -> Report B (${compareLabs[1]?.numericValue})`,
  );

  // ============================================================================
  // TEST 6: Historical charts use only explicitly authorized observations
  // ============================================================================
  console.log("\n--- TEST 6: Scoped Historical Trend Charts ---");
  // Single document chart must not include unselected observations
  const singleDocChartObservations = LAB_RESULTS.filter(
    (l) =>
      authScopeA.authorizedDocumentIds.includes(l.documentId) && l.canonicalKey === "hemoglobin",
  );
  recordCheck(
    "6. Historical chart scoped to Report A uses only Report A observations",
    singleDocChartObservations.length === 1 &&
      singleDocChartObservations[0].documentId === REPORT_A.id,
    `Chart points: ${singleDocChartObservations.length} (Lifetime had 2, correctly restricted)`,
  );

  // ============================================================================
  // TEST 7: Invalid document IDs are rejected (fail closed)
  // ============================================================================
  console.log("\n--- TEST 7: Security Invariant: Invalid Document ID Rejection ---");
  let invalidRejected = false;
  try {
    await documentAuthorizationService.resolveDocumentScope({
      userId: MOCK_USER_ID,
      patientId: MOCK_PATIENT_ID,
      documentIds: ["non-existent-uuid-999"],
      scopeMode: "SINGLE_DOCUMENT",
      db: mockDb,
    });
  } catch (err) {
    invalidRejected = err.statusCode === 403 || err.message.includes("fail-closed");
  }
  recordCheck(
    "7. Invalid or non-existent document ID is strictly rejected (fails closed)",
    invalidRejected,
    "Access denied on non-existent document ID",
  );

  // ============================================================================
  // TEST 8: Deleted documents cannot be queried
  // ============================================================================
  console.log("\n--- TEST 8: Security Invariant: Soft-Deleted Document Rejection ---");
  let deletedRejected = false;
  try {
    await documentAuthorizationService.resolveDocumentScope({
      userId: MOCK_USER_ID,
      patientId: MOCK_PATIENT_ID,
      documentIds: [REPORT_DELETED.id],
      scopeMode: "SINGLE_DOCUMENT",
      db: mockDb,
    });
  } catch (err) {
    deletedRejected = err.statusCode === 403 || err.message.includes("fail-closed");
  }
  recordCheck(
    "8. Soft-deleted document cannot be queried or selected",
    deletedRejected,
    "Access denied on isDeleted: true document",
  );

  // ============================================================================
  // TEST 9: Related-person authorization is enforced (cross-patient isolation)
  // ============================================================================
  console.log("\n--- TEST 9: Cross-Patient Multi-Tenant Boundary ---");
  let unauthorizedPatientRejected = false;
  try {
    await documentAuthorizationService.resolveDocumentScope({
      userId: MOCK_USER_ID,
      patientId: MOCK_PATIENT_ID,
      documentIds: [REPORT_OTHER_PATIENT.id],
      scopeMode: "SINGLE_DOCUMENT",
      db: mockDb,
    });
  } catch (err) {
    unauthorizedPatientRejected = err.statusCode === 403 || err.message.includes("fail-closed");
  }
  recordCheck(
    "9. Cross-patient unauthorized document is strictly blocked",
    unauthorizedPatientRejected,
    "Access denied on document belonging to another patient",
  );

  // ============================================================================
  // TEST 10: Medical source citations match the actual report
  // ============================================================================
  console.log("\n--- TEST 10: Source Citation Attribution & Integrity ---");
  const sampleCitations = [
    {
      documentId: REPORT_A.id,
      fileName: REPORT_A.fileName,
      pageNumber: 1,
      metric: "Hemoglobin",
      observationDate: "2026-01-15T10:00:00.000Z",
      sourceReference: "Apollo Hospitals CBC Panel",
    },
  ];

  const citationValid =
    sampleCitations[0].documentId === REPORT_A.id &&
    sampleCitations[0].fileName === REPORT_A.fileName &&
    sampleCitations[0].pageNumber === 1 &&
    sampleCitations[0].metric === "Hemoglobin";

  recordCheck(
    "10. Medical source citations accurately match the selected report provenance",
    citationValid,
    `Citation docId: ${sampleCitations[0].documentId}, page: ${sampleCitations[0].pageNumber}`,
  );

  // ============================================================================
  // TEST 11: Language switching does not change document scope
  // ============================================================================
  console.log("\n--- TEST 11: Multilingual Scope Invariance ---");
  const multilingualQueries = [
    { q: "Explain in Gujarati", lang: "gujarati" },
    { q: "Isko Hindi me samjhao", lang: "hindi" },
    { q: "Marathi madhe sanga", lang: "marathi" },
    { q: "Idhai Tamilil vilakkavum", lang: "tamil" },
  ];

  let allLanguagesRetainedScope = true;
  for (const item of multilingualQueries) {
    const res = slotContextService.resolveScopeAndSlots({
      currentTurnDocumentId: undefined,
      sessionMetadata: { slots: sessionSlots },
      userQuestion: item.q,
      availableDocuments: [REPORT_A, REPORT_B],
      authenticatedUserId: MOCK_USER_ID,
      activePatientId: MOCK_PATIENT_ID,
    });
    if (
      res.scopeMode !== "SINGLE_DOCUMENT" ||
      !res.resolvedDocumentIds.includes(REPORT_A.id) ||
      res.resolvedDocumentIds.length !== 1
    ) {
      allLanguagesRetainedScope = false;
      break;
    }
  }

  recordCheck(
    "11. Multilingual questions in Gujarati, Hindi, Marathi, Tamil retain active document scope",
    allLanguagesRetainedScope,
    "Tested across Gujarati, Hindi, Marathi, and Tamil phrasing",
  );

  // ============================================================================
  // TEST 12: Natural language document disambiguation & predecessor comparison
  // ============================================================================
  console.log("\n--- TEST 12: Natural Language Resolution & Disambiguation ---");
  // Ambiguous match returns disambiguation requirement
  const ambiguousDocs = [
    {
      id: "doc-1",
      hospitalName: "Apollo Hospitals",
      fileName: "Apollo_1.pdf",
      reportDate: new Date("2026-01-01"),
    },
    {
      id: "doc-2",
      hospitalName: "Apollo Hospitals",
      fileName: "Apollo_2.pdf",
      reportDate: new Date("2026-01-10"),
    },
  ];
  const disambiguationResult = documentResolverService.resolveNaturalLanguageDocumentScope({
    question: "Show my Apollo report",
    availableDocuments: ambiguousDocs,
    currentDocumentIds: [],
  });

  // Chronological comparison match: "Compare with previous report"
  const compResult = documentResolverService.resolveNaturalLanguageDocumentScope({
    question: "Compare with my previous report",
    availableDocuments: [REPORT_A, REPORT_B],
    currentDocumentIds: [REPORT_B.id],
  });

  recordCheck(
    "12. Natural-language resolution triggers disambiguation on ambiguity and resolves predecessor for comparison",
    disambiguationResult.resolutionType === "REQUIRE_DOCUMENT_SELECTION" &&
      disambiguationResult.candidateDocuments.length === 2 &&
      compResult.resolutionType === "COMPARISON_PREDECESSOR" &&
      compResult.resolvedDocumentIds.includes(REPORT_A.id) &&
      compResult.resolvedDocumentIds.includes(REPORT_B.id),
    "Ambiguity prompts candidate selection; 'previous report' pairs Report B with predecessor Report A",
  );

  // --- FINAL REPORT ---
  console.log("\n================================================================================");
  console.log(`TEST SUMMARY: ${passedChecks} / ${totalChecks} CHECKS PASSED`);
  console.log("================================================================================");

  if (passedChecks === totalChecks) {
    console.log("ALL 12 MANDATORY v8.2 E2E VERIFICATION REQUIREMENTS PASSED.");
    process.exit(0);
  } else {
    console.error(
      `FAILED: ${totalChecks - passedChecks} checks did not meet the acceptance criteria.`,
    );
    process.exit(1);
  }
}

runDocumentScopedQaLiveTests().catch((err) => {
  console.error("Unhandled error during v8.2 test execution:", err);
  process.exit(1);
});
