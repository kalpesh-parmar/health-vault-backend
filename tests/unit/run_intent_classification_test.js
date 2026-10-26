const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");

async function run() {
  console.log("=== Testing Phase 2: Medical Intent Classification and Routing ===");

  // 1. OUT_OF_SCOPE
  console.log("\n--- Test 1: OUT_OF_SCOPE (Prompt Injection / Non-Medical) ---");
  const t1 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "Write a python script to scrape data",
  });
  console.log("Input: 'Write a python script to scrape data' ->", t1);
  if (t1.intent !== "OUT_OF_SCOPE") throw new Error("Test 1 Failed!");
  console.log("PASS ✓");

  // 2. MEDICAL_TREND_CHART
  console.log("\n--- Test 2: MEDICAL_TREND_CHART ---");
  const t2 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "Show my fasting blood sugar trend over time",
  });
  console.log("Input: 'Show my fasting blood sugar trend over time' ->", t2);
  if (t2.intent !== "MEDICAL_TREND_CHART" || t2.canonicalMetric !== "glucose_fasting") {
    throw new Error("Test 2 Failed!");
  }
  console.log("PASS ✓");

  // 3. DOCUMENT_SUMMARY
  console.log("\n--- Test 3: DOCUMENT_SUMMARY ---");
  const t3 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "Mara report no saransh samjhavo",
    englishQuestion: "Explain my report summary",
  });
  console.log("Input: 'Explain my report summary' ->", t3);
  if (t3.intent !== "DOCUMENT_SUMMARY") throw new Error("Test 3 Failed!");
  console.log("PASS ✓");

  // 4. FACT_LOOKUP
  console.log("\n--- Test 4: FACT_LOOKUP ---");
  const t4 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "What is my HbA1c value?",
  });
  console.log("Input: 'What is my HbA1c value?' ->", t4);
  if (t4.intent !== "FACT_LOOKUP" || t4.canonicalMetric !== "hba1c") {
    throw new Error("Test 4 Failed!");
  }
  console.log("PASS ✓");

  // 5. DOCUMENT_COMPARISON
  console.log("\n--- Test 5: DOCUMENT_COMPARISON ---");
  const t5 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "Compare with 2025 report",
  });
  console.log("Input: 'Compare with 2025 report' ->", t5);
  if (t5.intent !== "DOCUMENT_COMPARISON") throw new Error("Test 5 Failed!");
  console.log("PASS ✓");

  // 6. TABLE_REQUEST
  console.log("\n--- Test 6: TABLE_REQUEST ---");
  const t6 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "Show all my blood test results in a table",
  });
  console.log("Input: 'Show all my blood test results in a table' ->", t6);
  if (t6.intent !== "TABLE_REQUEST") throw new Error("Test 6 Failed!");
  console.log("PASS ✓");

  // 7. FOLLOW_UP
  console.log("\n--- Test 7: FOLLOW_UP ---");
  const t7 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "What about 2026?",
    sessionContext: { activeMetric: "glucose_fasting" },
  });
  console.log("Input: 'What about 2026?' with context ->", t7);
  if (t7.intent !== "FOLLOW_UP" || t7.canonicalMetric !== "glucose_fasting") {
    throw new Error("Test 7 Failed!");
  }
  console.log("PASS ✓");

  // 8. CLARIFICATION_REQUIRED
  console.log("\n--- Test 8: CLARIFICATION_REQUIRED ---");
  const t8 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "??",
  });
  console.log("Input: '??' ->", t8);
  if (t8.intent !== "CLARIFICATION_REQUIRED" || !t8.isAmbiguous) {
    throw new Error("Test 8 Failed!");
  }
  console.log("PASS ✓");

  // 9. MEDICAL_EXPLANATION
  console.log("\n--- Test 9: MEDICAL_EXPLANATION ---");
  const t9 = chatClassifier.classifyMedicalIntent({
    rawQuestion: "Why is elevated bilirubin dangerous for liver health?",
  });
  console.log("Input: 'Why is elevated bilirubin dangerous?' ->", t9);
  if (t9.intent !== "MEDICAL_EXPLANATION") throw new Error("Test 9 Failed!");
  console.log("PASS ✓");

  // 10. Overall chatClassifier.classify integration
  console.log("\n--- Test 10: chatClassifier.classify integration ---");
  const t10 = chatClassifier.classify({
    rawQuestion: "Plot my hemoglobin chart over 2024 and 2025",
  });
  console.log("Integrated classification medicalIntent:", t10.medicalIntent);
  if (
    t10.medicalIntent.intent !== "MEDICAL_TREND_CHART" ||
    t10.medicalIntent.canonicalMetric !== "hemoglobin"
  ) {
    throw new Error("Test 10 Failed!");
  }
  console.log("PASS ✓");

  console.log("\n=======================================================");
  console.log("ALL 10 MEDICAL INTENT CLASSIFICATION TESTS PASSED! ✓");
  console.log("=======================================================");
}

run().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
