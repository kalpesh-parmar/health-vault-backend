const { patientLabResultRepository } = require("../../src/repositories/patientLabResultRepository");
const { medicalFactLookupService } = require("../../src/services/medicalFactLookup.service");

async function run() {
  console.log("=== Testing Phase 3: Structured Medical Facts and Hybrid RAG ===");

  // 1. Synonym to Canonical Resolution
  console.log("\n--- Test 1: Canonical Synonym Resolution ---");
  const s1 = medicalFactLookupService.resolveCanonicalKey("fasting blood sugar");
  const s2 = medicalFactLookupService.resolveCanonicalKey("HbA1c");
  const s3 = medicalFactLookupService.resolveCanonicalKey("serum creatinine");
  console.log("'fasting blood sugar' ->", s1);
  console.log("'HbA1c' ->", s2);
  console.log("'serum creatinine' ->", s3);

  if (s1 !== "glucose_fasting" || s2 !== "hba1c" || s3 !== "creatinine_serum") {
    throw new Error("Test 1 Failed: Synonym mapping incorrect!");
  }
  console.log("PASS ✓");

  // 2. Structured Table Markdown Formatting
  console.log("\n--- Test 2: Structured Table Formatting ---");
  const mockObservations = [
    {
      testDate: new Date("2025-01-15T08:30:00Z"),
      testName: "Fasting Blood Glucose",
      valueNumeric: 126.0,
      unit: "mg/dL",
      referenceRange: "70 - 99 mg/dL",
      isAbnormal: true,
      flag: "HIGH",
      pageNo: 1,
    },
    {
      testDate: new Date("2025-06-20T09:00:00Z"),
      testName: "Fasting Blood Glucose",
      valueNumeric: 110.0,
      unit: "mg/dL",
      referenceRange: "70 - 99 mg/dL",
      isAbnormal: true,
      flag: "HIGH",
      pageNo: 2,
    },
  ];

  const tableMd = medicalFactLookupService.formatAsMarkdownTable(mockObservations);
  console.log("Generated Markdown Table:\n" + tableMd);

  if (
    !tableMd.includes("126") ||
    !tableMd.includes("mg/dL") ||
    !tableMd.includes("70 - 99 mg/dL") ||
    !tableMd.includes("Page 1") ||
    !tableMd.includes("**HIGH**")
  ) {
    throw new Error("Test 2 Failed: Table Markdown missing expected data!");
  }
  console.log("PASS ✓");

  // 3. Repository methods integrity
  console.log("\n--- Test 3: Repository Methods Integrity ---");
  if (
    typeof patientLabResultRepository.findByCanonicalKey !== "function" ||
    typeof patientLabResultRepository.findByCanonicalKeys !== "function" ||
    typeof patientLabResultRepository.aggregateByPeriod !== "function" ||
    typeof patientLabResultRepository.findLatestByUserId !== "function" ||
    typeof patientLabResultRepository.findAbnormalObservations !== "function"
  ) {
    throw new Error("Test 3 Failed: Missing repository methods!");
  }
  console.log("PASS ✓ (All repository query methods defined)");

  console.log("\n=======================================================");
  console.log("ALL STRUCTURED LAB RAG AND REPOSITORY TESTS PASSED! ✓");
  console.log("=======================================================");
}

run().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
