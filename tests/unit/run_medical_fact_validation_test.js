const assert = require("assert");
const { medicalFactValidatorService } = require("../../src/services/medicalFactValidator.service");
const {
  maskMedicalTokens,
  unmaskMedicalTokens,
  validatePlaceholderIntegrity,
} = require("../../src/utils/textCleanUtils");

async function runTests() {
  console.log("=== Testing Phase 6: MedGemma Grounded Medical Answering & Fact Validation ===\n");

  // Sample verified lab records from PostgreSQL
  const verifiedRecords = [
    {
      testName: "HbA1c",
      canonicalName: "hba1c",
      numericValue: 5.8,
      unit: "%",
      status: "NORMAL",
      referenceRange: "4.0 - 5.6",
      observationDate: "2026-02-15",
    },
    {
      testName: "Fasting Blood Sugar",
      canonicalName: "glucose_fasting",
      numericValue: 92.0,
      unit: "mg/dL",
      status: "NORMAL",
      referenceRange: "70.0 - 99.0",
      observationDate: "2026-02-15",
    },
    {
      testName: "Hemoglobin",
      canonicalName: "hemoglobin",
      numericValue: 14.2,
      unit: "g/dL",
      status: "NORMAL",
      referenceRange: "13.0 - 17.0",
      observationDate: "2026-02-15",
    },
  ];

  // Test 1: Grounded answer (accurate claims)
  console.log("--- Test 1: Grounded Verification (Accurate Claims) ---");
  const accurateAnswer =
    "According to your recent report, your HbA1c is 5.8% which is in good control, and your Fasting Blood Sugar was 92 mg/dL.";
  const result1 = medicalFactValidatorService.verifyMedicalFacts(accurateAnswer, verifiedRecords);

  console.log("Accurate answer validation:", {
    isValid: result1.isValid,
    claimsFound: result1.claims.length,
    hallucinations: result1.hallucinations.length,
  });
  assert.strictEqual(result1.isValid, true, "Accurate answer should be valid");
  assert.strictEqual(result1.hallucinations.length, 0, "No hallucinations should be flagged");
  console.log("PASS ✓ (Accurate answer validated without flagging)\n");

  // Test 2: Hallucinated answer (fabricated numbers)
  console.log("--- Test 2: Anti-Hallucination Gate (Fabricated Claims) ---");
  const hallucinatedAnswer =
    "Your HbA1c is 8.5% which is dangerously elevated, and your Fasting Blood Sugar was 180 mg/dL.";
  const result2 = medicalFactValidatorService.verifyMedicalFacts(
    hallucinatedAnswer,
    verifiedRecords,
  );

  console.log("Hallucinated answer validation:", {
    isValid: result2.isValid,
    claimsFound: result2.claims.length,
    hallucinations: result2.hallucinations.length,
    sanitizedSnippet: result2.sanitizedText.substring(0, 150) + "...",
  });
  assert.strictEqual(result2.isValid, false, "Hallucinated answer must be detected as invalid");
  assert.strictEqual(
    result2.hallucinations.length,
    2,
    "Both fabricated values (HbA1c & FBS) must be caught",
  );
  assert.ok(
    result2.sanitizedText.includes("Verified Clinical Discrepancy Notice"),
    "Discrepancy notice must be attached",
  );
  console.log("PASS ✓ (Fabricated clinical claims detected and neutralized)\n");

  // Test 3: Translation Entity Shielding
  console.log("--- Test 3: Translation Entity Shielding (REQ-ML-06) ---");
  const sampleSentence = "Your Fasting Blood Sugar is 92.0 mg/dL and HbA1c is 5.8% on 15-Feb-2026.";
  const { maskedText, placeholders } = maskMedicalTokens(sampleSentence);

  console.log("Original sentence:", sampleSentence);
  console.log("Masked sentence:  ", maskedText);
  console.log(
    "Placeholders extracted:",
    placeholders.map((p) => `${p.placeholder} => ${p.original}`),
  );

  assert.ok(placeholders.length >= 3, "Must capture numbers, units, and dates");
  assert.strictEqual(
    validatePlaceholderIntegrity(maskedText, placeholders),
    true,
    "Placeholder integrity must pass",
  );

  // Simulate translation preserving placeholders
  const simulatedGujarati = maskedText
    .replace("Your Fasting Blood Sugar is", "તમારું ફાસ્ટિંગ બ્લડ સુગર")
    .replace("and HbA1c is", "છે અને HbA1c")
    .replace("on", "તારીખે છે");

  const restored = unmaskMedicalTokens(simulatedGujarati, placeholders);
  console.log("Restored translation:", restored);

  assert.ok(restored.includes("92.0 mg/dL"), "Exact numeric value and unit must be restored");
  assert.ok(restored.includes("5.8%"), "Exact percentage must be restored");
  assert.ok(restored.includes("15-Feb-2026"), "Date token must be restored");
  console.log("PASS ✓ (Numbers, units, and clinical tokens preserved identically)\n");

  console.log("=======================================================");
  console.log("ALL PHASE 6 MEDGEMMA & FACT VALIDATION TESTS PASSED! ✓");
  console.log("=======================================================");
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
