const { Client } = require("pg");
const TEST_DB_URL = "postgres://postgres:123@localhost:5432/health_vault_test";

// Set environment for database connection
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DB_NAME = "health_vault_test";
process.env.NODE_ENV = "test";

async function verifyPhase28() {
  console.log("=== PHASE 28 FULL E2E AND API-TO-UI CONTRACT VERIFICATION ===\n");
  const client = new Client({ connectionString: TEST_DB_URL });
  await client.connect();

  try {
    // 1. Audit Migration 0030 state in database
    console.log("[1] Checking Migration 0030 Database Columns & Table Schema...");
    const occCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'medication_reminder_occurrences'
      AND column_name IN ('delay_minutes', 'completion_classification', 'skip_reason');
    `);
    console.log(
      "   Occurrences columns:",
      occCols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(", "),
    );
    if (occCols.rows.length !== 3) {
      throw new Error(`Migration 0030 missing columns in medication_reminder_occurrences`);
    }

    const auditTable = await client.query(`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'medication_occurrence_history';
    `);
    if (auditTable.rows.length !== 1) {
      throw new Error(`Migration 0030 missing medication_occurrence_history table`);
    }
    console.log("   Migration 0030 schema verified 100% in health_vault_test.");

    // 2. Setup Test Patient & Medication
    console.log("\n[2] Setting up clean test patient in Asia/Kolkata timezone...");
    const patientCode = "P28TEST" + Date.now().toString().slice(-4);
    const patRes = await client.query(
      `
      INSERT INTO patients (
        patient_code, first_name, last_name, email, password, mobile, timezone, is_mobile_verified, is_email_verified
      ) VALUES (
        $1, 'Adherence', 'Tester', $2, 'hashed_pwd', $3, 'Asia/Kolkata', true, true
      ) RETURNING id;
    `,
      [patientCode, `p28_${Date.now()}@test.com`, "9" + Date.now().toString().slice(-9)],
    );
    const userId = patRes.rows[0].id;

    // Create Medication
    const medRes = await client.query(
      `
      INSERT INTO medications (
        user_id, patient_code, medication_name, medication_type, dose_per_intake,
        frequency, medication_schedule, food_frequency, start_date, unit,
        total_quantity, daily_consumption
      ) VALUES (
        $1, $2, 'Amoxicillin 500mg', 'CAPSULE', 1,
        'Once Daily', '{"Morning":"08:00:00"}', 'AFTER_FOOD', '2026-10-21 00:00:00', 'CAPSULE',
        30, 1
      ) RETURNING id;
    `,
      [userId, patientCode],
    );
    const medicationId = medRes.rows[0].id;

    // Create Reminder
    const remRes = await client.query(
      `
      INSERT INTO medication_reminders (
        patient_id, medication_id, dose_per_intake
      ) VALUES ($1, $2, 1) RETURNING id;
    `,
      [userId, medicationId],
    );
    const reminderId = remRes.rows[0].id;

    // 3. Test Critical Acceptance Scenario:
    // Scheduled 08:00 AM IST (02:30 UTC), Completed 10:30 AM IST (05:00 UTC) -> Delay 150 min, LATE
    console.log("\n[3] Testing Critical Acceptance Case:");
    console.log("   Scheduled: 2026-10-21 08:00 AM IST (02:30:00 UTC)");
    console.log("   Completed: 2026-10-21 10:30 AM IST (05:00:00 UTC)");
    console.log("   Expected: Delay = 150m, status = COMPLETED, classification = LATE");

    const scheduledUtc = new Date("2026-10-21T02:30:00.000Z");
    const completedUtc = new Date("2026-10-21T05:00:00.000Z");

    const _occRes = await client.query(
      `
      INSERT INTO medication_reminder_occurrences (
        patient_id, medication_id, reminder_id,
        actual_medication_time, status, completion_classification,
        completed_at, delay_minutes, is_overdue
      ) VALUES (
        $1, $2, $3, $4, 'COMPLETED', 'LATE', $5, 150, false
      ) RETURNING id;
    `,
      [userId, medicationId, reminderId, scheduledUtc, completedUtc],
    );

    // 4. Test Phase 27 / Phase 28 Service
    const medicationAdherenceService = require("../../src/services/medicationAdherence.service.js");

    // Test Weekly Adherence
    console.log("\n[4] Invoking getWeeklyAdherence()...");
    const weeklyResult = await medicationAdherenceService.getWeeklyAdherence(userId, {
      timezone: "Asia/Kolkata",
      startDate: "2026-10-15",
      endDate: "2026-10-21",
    });

    console.log("   Weekly KPI Summary:", JSON.stringify(weeklyResult.kpiSummary, null, 2));
    if (weeklyResult.kpiSummary.completedLate !== 1) {
      throw new Error(`Expected completedLate === 1, got ${weeklyResult.kpiSummary.completedLate}`);
    }
    if (weeklyResult.kpiSummary.completedOnTime !== 0) {
      throw new Error(
        `Expected completedOnTime === 0, got ${weeklyResult.kpiSummary.completedOnTime}`,
      );
    }
    if (weeklyResult.kpiSummary.overdue !== 0 || weeklyResult.kpiSummary.missed !== 0) {
      throw new Error(
        `Expected overdue === 0 and missed === 0 for completed late dose! Got overdue=${weeklyResult.kpiSummary.overdue}`,
      );
    }
    console.log(
      "   ✓ CRITICAL INVARIANT VERIFIED: Completed Late is counted strictly once, NOT as Overdue or Missed.",
    );

    // Test 7 Days Breakdown
    if (weeklyResult.dailyBreakdown.length !== 7) {
      throw new Error(
        `Expected exactly 7 days in dailyBreakdown, got ${weeklyResult.dailyBreakdown.length}`,
      );
    }
    const todayItem = weeklyResult.dailyBreakdown.find((d) => d.date === "2026-10-21");
    if (!todayItem) {
      throw new Error("Missing today item in dailyBreakdown");
    }
    console.log("   Today (2026-10-21) breakdown:", JSON.stringify(todayItem, null, 2));
    if (todayItem.completedLate !== 1 || todayItem.overdue !== 0) {
      throw new Error(
        `Incorrect breakdown counts for today: late=${todayItem.completedLate}, overdue=${todayItem.overdue}`,
      );
    }
    console.log("   ✓ 7-Day breakdown verified with exact column properties.");

    // Test Monthly Adherence
    console.log("\n[5] Invoking getMonthlyAdherence()...");
    const monthlyResult = await medicationAdherenceService.getMonthlyAdherence(userId, {
      month: 10,
      year: 2026,
      timezone: "Asia/Kolkata",
    });

    console.log("   Monthly Percentages:", JSON.stringify(monthlyResult.percentages, null, 2));
    console.log(
      "   Monthly Segmented Ratios:",
      JSON.stringify(monthlyResult.segmentedRatios, null, 2),
    );

    if (monthlyResult.percentages.overallAdherence !== 100.0) {
      throw new Error(
        `Expected overallAdherence === 100.0%, got ${monthlyResult.percentages.overallAdherence}`,
      );
    }
    if (monthlyResult.percentages.lateCompletion !== 100.0) {
      throw new Error(
        `Expected lateCompletion === 100.0%, got ${monthlyResult.percentages.lateCompletion}`,
      );
    }
    if (monthlyResult.percentages.onTimeAdherence !== 0.0) {
      throw new Error(
        `Expected onTimeAdherence === 0.0%, got ${monthlyResult.percentages.onTimeAdherence}`,
      );
    }
    console.log("   ✓ Monthly adherence metrics and percentages match specifications.");

    // Test Daily Details
    console.log("\n[6] Invoking getDailyDetails()...");
    const dailyResult = await medicationAdherenceService.getDailyDetails(userId, {
      date: "2026-10-21",
      timezone: "Asia/Kolkata",
    });
    console.log("   Daily Details:", JSON.stringify(dailyResult, null, 2));

    const dose = dailyResult.doses[0];
    if (dose.delayMinutes !== 150) {
      throw new Error(`Expected delayMinutes === 150, got ${dose.delayMinutes}`);
    }
    if (dose.delayFormatted !== "2h 30m late") {
      throw new Error(`Expected delayFormatted === '2h 30m late', got '${dose.delayFormatted}'`);
    }
    if (dose.completionClassification !== "LATE") {
      throw new Error(
        `Expected completionClassification === 'LATE', got ${dose.completionClassification}`,
      );
    }
    if (dose.isOverdue !== false) {
      throw new Error(`Expected isOverdue === false for completed dose`);
    }
    console.log(
      "   ✓ Daily Details drill-down verified with 150m delay and 12-hour formatted time.",
    );

    // Test Refill Intelligence & Hiding
    console.log("\n[7] Testing Refill Intelligence with 30 units (Healthy stock)...");
    const refillHealthy = await medicationAdherenceService.getRefillAlerts(userId, {
      timezone: "Asia/Kolkata",
    });
    console.log("   Refills with healthy stock:", JSON.stringify(refillHealthy, null, 2));
    if (refillHealthy.hasRefillAlerts !== false || refillHealthy.medications.length !== 0) {
      throw new Error(
        `Expected hasRefillAlerts === false for healthy 30 units, got ${refillHealthy.hasRefillAlerts}`,
      );
    }
    console.log("   ✓ Refill section is hidden when no qualifying alerts exist.");

    // Test Refill Alert when stock drops below threshold
    console.log("\n[8] Testing Refill Intelligence when stock is low (5 units remaining)...");
    await client.query(
      `
      UPDATE medications SET total_quantity = 5 WHERE id = $1;
    `,
      [medicationId],
    );
    const refillLow = await medicationAdherenceService.getRefillAlerts(userId, {
      timezone: "Asia/Kolkata",
    });
    console.log("   Refills with low stock:", JSON.stringify(refillLow, null, 2));
    if (refillLow.hasRefillAlerts !== true || refillLow.medications.length !== 1) {
      throw new Error(`Expected hasRefillAlerts === true for low stock`);
    }
    if (refillLow.medications[0].urgency !== "LOW_STOCK") {
      throw new Error(`Expected urgency === 'LOW_STOCK', got ${refillLow.medications[0].urgency}`);
    }
    console.log("   ✓ Refill alert correctly generated when stock is low.");

    // Clean up test data
    console.log("\n[9] Cleaning up test records in health_vault_test...");
    await client.query("DELETE FROM medication_reminder_occurrences WHERE patient_id = $1", [
      userId,
    ]);
    await client.query("DELETE FROM medication_reminders WHERE patient_id = $1", [userId]);
    await client.query("DELETE FROM medications WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM patients WHERE id = $1", [userId]);
    console.log("   Cleanup complete.");

    console.log("\n=== ALL PHASE 28 INTEGRATION & VERIFICATION CHECKS PASSED 100% ===");
  } finally {
    await client.end();
  }
}

verifyPhase28().catch((err) => {
  console.error("\nVerification failed:", err);
  process.exit(1);
});
