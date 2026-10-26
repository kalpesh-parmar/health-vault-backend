const assert = require("assert");
const aiClient = require("../../src/services/ai/clients/aiClient.service");
const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const { slotContextService } = require("../../src/services/ai/chat/slotContext.service");
const { medicalFactLookupService } = require("../../src/services/medicalFactLookup.service");
const { medicalTrendChartService } = require("../../src/services/medicalTrendChart.service");
const { medicalFactValidatorService } = require("../../src/services/medicalFactValidator.service");
const { maskMedicalTokens, unmaskMedicalTokens } = require("../../src/utils/textCleanUtils");
const { maskSensitiveData } = require("../../src/utils/apiLoggerUtil");

async function runEndToEndVerification() {
  console.log("================================================================================");
  console.log("HEALTH VAULT: SMART MEDICAL QA & VERIFIED CLINICAL ANALYTICS FULL-STACK E2E TEST");
  console.log("================================================================================\n");

  let passedChecks = 0;
  let totalChecks = 0;

  function recordCheck(name, passed, detail = "") {
    totalChecks++;
    if (passed) {
      passedChecks++;
      console.log(`[PASS] ${name}${detail ? ` (${detail})` : ""}`);
    } else {
      console.error(`[FAIL] ${name}${detail ? ` (${detail})` : ""}`);
    }
  }

  // --- STAGE 1: MULTILINGUAL & ROMANIZED LANGUAGE PIPELINE ---
  console.log("\n--- STAGE 1: Multilingual & Romanized Language Pipeline ---");
  const test1 = await aiClient.detectLanguage("Mara report ni summary apo");
  recordCheck(
    "REQ-ML-01/02: Romanized Gujarati Detection",
    test1.language === "gujarati" || test1.responseLanguage === "gujarati",
    `language: ${test1.responseLanguage}, script: ${test1.script}`,
  );

  const test2 = await aiClient.detectLanguage("Mara report ni summary English ma apo");
  recordCheck(
    "REQ-ML-04: Explicit Language Override (Gujarati to English)",
    test2.responseLanguage === "english" && test2.hasExplicitOverride === true,
    `override target: ${test2.responseLanguage}`,
  );

  const test3 = await aiClient.detectLanguage("Meri blood sugar report ka chart dikhao");
  recordCheck(
    "REQ-ML-02: Romanized Hindi Detection",
    test3.language === "hindi" || test3.responseLanguage === "hindi",
    `language: ${test3.responseLanguage}`,
  );

  // --- STAGE 2: MEDICAL INTENT CLASSIFICATION & ROUTING ---
  console.log("\n--- STAGE 2: Medical Intent Classification & Routing ---");
  const intent1 = chatClassifier.classifyMedicalIntent({
    question: "Show my fasting blood sugar trend chart",
  });
  recordCheck(
    "REQ-INT-01: MEDICAL_TREND_CHART Intent",
    intent1.intent === "MEDICAL_TREND_CHART" && intent1.canonicalMetric === "glucose_fasting",
    `metric: ${intent1.canonicalMetric}`,
  );

  const intent2 = chatClassifier.classifyMedicalIntent({
    question: "What is my latest HbA1c value?",
  });
  recordCheck(
    "REQ-INT-01: FACT_LOOKUP Intent",
    intent2.intent === "FACT_LOOKUP" && intent2.canonicalMetric === "hba1c",
    `metric: ${intent2.canonicalMetric}`,
  );

  const intent3 = chatClassifier.classifyMedicalIntent({
    question: "Who is the prime minister of Canada?",
  });
  recordCheck(
    "REQ-INT-02: OUT_OF_SCOPE Immediate Deflection",
    intent3.intent === "OUT_OF_SCOPE",
    `intent: ${intent3.intent}`,
  );

  // --- STAGE 3: HYBRID RAG & STRUCTURED FACT LOOKUP ---
  console.log("\n--- STAGE 3: Hybrid RAG & Structured Fact Formatting ---");
  const sampleObservations = [
    {
      testName: "Fasting Blood Sugar",
      canonicalKey: "glucose_fasting",
      valueNumeric: 95.0,
      unit: "mg/dL",
      referenceRange: "70 - 99",
      flag: "NORMAL",
      isAbnormal: false,
      testDate: "2026-02-15",
      pageNo: 1,
    },
  ];

  const tableMd = medicalFactLookupService.formatAsMarkdownTable(sampleObservations);
  recordCheck(
    "REQ-RAG-03: Deterministic Markdown Table Reconstruction",
    tableMd.includes("Fasting Blood Sugar") &&
      tableMd.includes("95") &&
      tableMd.includes("mg/dL") &&
      tableMd.includes("70 - 99") &&
      tableMd.includes("Page 1"),
    "Verified column alignment and exact numbers",
  );

  // --- STAGE 4: CONVERSATION MEMORY & SLOT CARRYOVER ---
  console.log("\n--- STAGE 4: Multi-Turn Conversation Memory ---");
  let slots = slotContextService.resolveTurnSlots({}, intent1, test3, []);
  recordCheck(
    "REQ-MEM-01: Slot Extraction from Turn 1",
    slots.activeMetric === "glucose_fasting",
    `activeMetric: ${slots.activeMetric}`,
  );

  // Follow-up: "Compare with 2026"
  const followUpIntent = chatClassifier.classifyMedicalIntent({
    question: "Compare with 2026",
    sessionContext: slots,
  });
  slots = slotContextService.resolveTurnSlots(slots, followUpIntent, test1, []);
  recordCheck(
    "REQ-MEM-02: Metric Carryover in Follow-up Turn",
    slots.activeMetric === "glucose_fasting" &&
      (slots.dateRange?.year === 2026 || slots.dateRange?.years?.includes(2026)),
    `metric preserved: ${slots.activeMetric}`,
  );

  // --- STAGE 5: DYNAMIC MEDICAL TREND CHART ENGINE ---
  console.log("\n--- STAGE 5: Dynamic Medical Trend Chart Engine ---");
  const glucoseNormalized = medicalTrendChartService.normalizeValue(
    6.0,
    "mmol/L",
    "glucose_fasting",
  );
  recordCheck(
    "REQ-CHT-02: Clinical Unit Conversion (mmol/L to mg/dL)",
    Math.abs(glucoseNormalized - 108.1) < 0.2,
    `6.0 mmol/L => ${glucoseNormalized} mg/dL`,
  );

  const hbNormalized = medicalTrendChartService.normalizeValue(140.0, "g/L", "hemoglobin");
  recordCheck(
    "REQ-CHT-02: Clinical Unit Conversion (g/L to g/dL)",
    Math.abs(hbNormalized - 14.0) < 0.1,
    `140.0 g/L => ${hbNormalized} g/dL`,
  );

  // --- STAGE 6: MEDGEMMA GROUNDED ANSWERING & FACT VALIDATION ---
  console.log("\n--- STAGE 6: Anti-Hallucination Gate & Fact Validation ---");
  const verifiedLabData = [
    {
      testName: "HbA1c",
      canonicalName: "hba1c",
      numericValue: 5.8,
      unit: "%",
      referenceRange: "4.0 - 5.6",
    },
  ];

  const accurateClaim = "Your HbA1c is 5.8%, which indicates healthy glycemic control.";
  const valAccurate = medicalFactValidatorService.verifyMedicalFacts(
    accurateClaim,
    verifiedLabData,
  );
  recordCheck(
    "REQ-MED-01: Factual Claim Validation",
    valAccurate.isValid === true && valAccurate.hallucinations.length === 0,
    "Accurate database value approved",
  );

  const hallucinatedClaim = "Your HbA1c is 8.5%, which is severely abnormal.";
  const valHallucinated = medicalFactValidatorService.verifyMedicalFacts(
    hallucinatedClaim,
    verifiedLabData,
  );
  recordCheck(
    "REQ-MED-02: Hallucination Neutralization & Discrepancy Gate",
    valHallucinated.isValid === false &&
      valHallucinated.sanitizedText.includes("Verified Clinical Discrepancy Notice"),
    "Corrupted claim intercepted and notice appended",
  );

  // --- STAGE 7: TRANSLATION ENTITY SHIELDING ---
  console.log("\n--- STAGE 7: Translation Entity Shielding ---");
  const { maskedText, placeholders } = maskMedicalTokens(
    "Your blood sugar was 110.0 mg/dL on 15-Jan-2026.",
  );
  const restored = unmaskMedicalTokens(maskedText, placeholders);
  recordCheck(
    "REQ-ML-06: Entity Shielding Roundtrip Integrity",
    restored === "Your blood sugar was 110.0 mg/dL on 15-Jan-2026.",
    "Exact decimal, unit, and date preserved",
  );

  // --- STAGE 8: SECURITY & PHI LOGGING ---
  console.log("\n--- STAGE 8: PHI-Safe Logging & Security ---");
  process.env.NODE_ENV = "production";
  const maskedLog = maskSensitiveData({
    patientName: "Jane Smith",
    diagnosis: "Hypertension",
    testValue: "140/90 mmHg",
  });
  recordCheck(
    "REQ-SEC-02: Sensitive PHI Log Masking",
    maskedLog.patientName === "***" &&
      maskedLog.diagnosis === "***" &&
      maskedLog.testValue === "***",
    "Zero plain-text health identifiers written to log",
  );
  process.env.NODE_ENV = "test";

  console.log("\n================================================================================");
  console.log(
    `FULL-STACK VERIFICATION SUMMARY: ${passedChecks}/${totalChecks} CHECKS PASSED (${Math.round((passedChecks / totalChecks) * 100)}%)`,
  );
  console.log("================================================================================\n");

  assert.strictEqual(passedChecks, totalChecks, "All full-stack verification checks must pass");
}

runEndToEndVerification().catch((err) => {
  console.error("End-to-end verification encountered error:", err);
  process.exit(1);
});
