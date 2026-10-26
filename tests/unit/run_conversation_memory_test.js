const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const { slotContextService } = require("../../src/services/ai/chat/slotContext.service");

async function run() {
  console.log("=== Testing Phase 4: Multi-Turn Conversation Memory and Slot Carryover ===");

  let currentSlots = {};

  // Turn 1: "Show my blood sugar report for 2025."
  console.log("\n--- Turn 1: 'Show my blood sugar report for 2025.' ---");
  const q1 = "Show my blood sugar report for 2025.";
  const c1 = chatClassifier.classify({
    rawQuestion: q1,
    englishQuestion: q1,
    question: q1,
    sessionContext: currentSlots,
  });
  console.log("Turn 1 Classification:", c1.medicalIntent);
  currentSlots = slotContextService.resolveTurnSlots(currentSlots, c1, { language: "english" }, []);
  console.log("Turn 1 Slots:", currentSlots);

  if (
    currentSlots.activeMetric !== "glucose_random" &&
    currentSlots.activeMetric !== "glucose_fasting"
  ) {
    throw new Error("Turn 1 Failed: activeMetric not extracted!");
  }
  if (!currentSlots.dateRange || currentSlots.dateRange.year !== 2025) {
    throw new Error("Turn 1 Failed: year 2025 not captured!");
  }
  console.log("Turn 1 PASS ✓");

  // Turn 2: "Compare with 2026."
  console.log("\n--- Turn 2: 'Compare with 2026.' ---");
  const q2 = "Compare with 2026.";
  const c2 = chatClassifier.classify({
    rawQuestion: q2,
    englishQuestion: q2,
    question: q2,
    sessionContext: currentSlots,
  });
  console.log("Turn 2 Classification:", c2.medicalIntent);
  currentSlots = slotContextService.resolveTurnSlots(currentSlots, c2, { language: "english" }, []);
  console.log("Turn 2 Slots:", currentSlots);

  if (!currentSlots.activeMetric) {
    throw new Error("Turn 2 Failed: activeMetric lost during comparison!");
  }
  if (!currentSlots.dateRange.years || !currentSlots.dateRange.years.includes(2026)) {
    throw new Error("Turn 2 Failed: comparison year 2026 not added to years!");
  }
  console.log("Turn 2 PASS ✓ (Metric preserved, date range expanded)");

  // Turn 3: "Explain in Gujarati."
  console.log("\n--- Turn 3: 'Explain in Gujarati.' ---");
  const q3 = "Explain in Gujarati.";
  const c3 = chatClassifier.classify({
    rawQuestion: q3,
    englishQuestion: q3,
    question: q3,
    sessionContext: currentSlots,
  });
  currentSlots = slotContextService.resolveTurnSlots(
    currentSlots,
    c3,
    { language: "gujarati" },
    [],
  );
  console.log("Turn 3 Slots:", currentSlots);

  if (currentSlots.lastLanguage !== "gujarati") {
    throw new Error("Turn 3 Failed: Language not updated to Gujarati!");
  }
  if (!currentSlots.activeMetric) {
    throw new Error("Turn 3 Failed: Metric lost when switching language!");
  }
  console.log("Turn 3 PASS ✓ (Language switched to Gujarati, clinical slots intact)");

  // Turn 4: "What about hemoglobin?"
  console.log("\n--- Turn 4: 'What about hemoglobin?' ---");
  const q4 = "What about hemoglobin?";
  const c4 = chatClassifier.classify({
    rawQuestion: q4,
    englishQuestion: q4,
    question: q4,
    sessionContext: currentSlots,
  });
  console.log("Turn 4 Classification:", c4.medicalIntent);
  currentSlots = slotContextService.resolveTurnSlots(currentSlots, c4, { language: "english" }, []);
  console.log("Turn 4 Slots:", currentSlots);

  if (currentSlots.activeMetric !== "hemoglobin") {
    throw new Error("Turn 4 Failed: Metric did not switch to hemoglobin!");
  }
  if (!currentSlots.dateRange) {
    throw new Error("Turn 4 Failed: Date range lost!");
  }
  console.log("Turn 4 PASS ✓ (Metric updated to hemoglobin, date range preserved)");

  console.log("\n=======================================================");
  console.log("ALL 4 TURNS MAINTAINED FULL CLINICAL MEMORY INVARIANTS! ✓");
  console.log("=======================================================");
}

run().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
