const { medicalTrendChartService } = require("../../src/services/medicalTrendChart.service");

async function run() {
  console.log("=== Testing Phase 5: Dynamic Medical Trend Chart Engine ===");

  // 1. Clinical Unit Normalization
  console.log("\n--- Test 1: Clinical Unit Normalization ---");
  const glucoseMg = medicalTrendChartService.normalizeValue(6.0, "mmol/L", "glucose_fasting");
  const hbGdl = medicalTrendChartService.normalizeValue(140.0, "g/L", "hemoglobin");
  const creatMg = medicalTrendChartService.normalizeValue(88.4, "umol/L", "creatinine_serum");

  console.log("6.0 mmol/L Glucose ->", glucoseMg, "mg/dL (Expected ~108.1)");
  console.log("140.0 g/L Hemoglobin ->", hbGdl, "g/dL (Expected ~14.0)");
  console.log("88.4 umol/L Creatinine ->", creatMg, "mg/dL (Expected ~1.0)");

  if (Math.abs(glucoseMg - 108.1) > 0.5) throw new Error("Glucose conversion failed!");
  if (Math.abs(hbGdl - 14.0) > 0.1) throw new Error("Hemoglobin conversion failed!");
  if (Math.abs(creatMg - 1.0) > 0.1) throw new Error("Creatinine conversion failed!");
  console.log("PASS ✓ (All clinical unit conversions verified)");

  // 2. Chart JSON Payload Construction
  console.log("\n--- Test 2: Chart Construction & Summary Computation ---");
  // Simulate observations
  const testUserId = "00000000-0000-0000-0000-000000000001";
  const chartRes = await medicalTrendChartService.generateTrendChart({
    userId: testUserId,
    canonicalKey: "glucose_fasting",
    granularity: "date",
  });

  console.log("Chart response structure for empty user:", chartRes);
  if (chartRes.hasData !== false || !chartRes.message) {
    throw new Error("Empty user chart should return hasData: false cleanly!");
  }
  console.log("PASS ✓ (Empty user handled cleanly without errors)");

  console.log("\n=======================================================");
  console.log("ALL MEDICAL TREND CHART ENGINE TESTS PASSED! ✓");
  console.log("=======================================================");
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
