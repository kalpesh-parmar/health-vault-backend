const _http = require("http");
const { Client } = require("pg");
const axios = require("axios");

const TEST_DB_URL = "postgres://postgres:123@localhost:5432/health_vault_test";
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DB_NAME = "health_vault_test";
process.env.NODE_ENV = "test";

async function runHttpIntegrationTest() {
  console.log("=== PHASE 28 HTTP-LEVEL EXPRESS ROUTE & REFILL INTEGRATION TEST ===\n");

  const client = new Client({ connectionString: TEST_DB_URL });
  await client.connect();

  let server;
  let testUserId;
  let testSessionId;
  let accessToken;
  let testMedicationId;

  try {
    // 1. Audit Migration 0030 state in database and journal
    console.log("[1] Auditing Migration 0030 & Drizzle Journal...");
    const journal = require("../../drizzle/meta/_journal.json");
    const p30Entry = journal.entries.find((e) => e.idx === 30 || e.tag.includes("0030"));
    console.log("   Drizzle Journal Entry for Phase 26/27:", JSON.stringify(p30Entry));
    if (!p30Entry || p30Entry.tag !== "0030_medication_adherence_and_late_completion") {
      throw new Error(`Unexpected journal entry for migration 0030: ${JSON.stringify(p30Entry)}`);
    }

    const drizzleMigrations = await client.query(`
      SELECT table_name FROM information_schema.tables WHERE table_name = '__drizzle_migrations';
    `);
    if (drizzleMigrations.rows.length > 0) {
      const migRows = await client.query(
        `SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id;`,
      );
      console.log(`   Applied migrations count in health_vault_test: ${migRows.rows.length}`);
    } else {
      console.log(
        "   Note: Isolated test DB uses schema directly without __drizzle_migrations tracker.",
      );
    }

    // Verify database columns exist
    const occCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'medication_reminder_occurrences'
      AND column_name IN ('delay_minutes', 'completion_classification', 'skip_reason');
    `);
    console.log(
      "   Occurrence columns in test DB:",
      occCols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(", "),
    );
    if (occCols.rows.length !== 3) {
      throw new Error("Database schema in health_vault_test missing Migration 0030 columns!");
    }

    // 2. Setup Active Patient, Session, and Signed JWT
    console.log("\n[2] Setting up Active Patient, Session, and JWT Auth...");
    const patientCode = "P28HTTP" + Date.now().toString().slice(-4);
    const patRes = await client.query(
      `
      INSERT INTO patients (
        patient_code, first_name, last_name, email, password, mobile, timezone, status, is_mobile_verified, is_email_verified
      ) VALUES (
        $1, 'Http', 'Tester', $2, 'hashed_pwd', $3, 'Asia/Kolkata', 'ACTIVE', true, true
      ) RETURNING id;
    `,
      [patientCode, `http_${Date.now()}@test.com`, "9" + Date.now().toString().slice(-9)],
    );
    testUserId = patRes.rows[0].id;

    // Create Active Session
    const sessRes = await client.query(
      `
      INSERT INTO sessions (
        user_id, refresh_token_hash, refresh_token_expires_at, is_active, soft_delete
      ) VALUES (
        $1, 'fake_refresh_token_hash', NOW() + INTERVAL '7 days', true, false
      ) RETURNING id;
    `,
      [testUserId],
    );
    testSessionId = sessRes.rows[0].id;

    // Generate valid JWT using backend's JwtUtils
    const JwtUtils = require("../../src/utils/jwtUtils");
    accessToken = JwtUtils.generateAccessToken({
      userId: testUserId,
      sessionId: testSessionId,
      tokenType: "access",
    });
    console.log("   Authenticated Session & Access Token generated successfully.");

    // 3. Create Medication, Reminder, and Acceptance Dose
    // Scheduled: 08:00 AM IST (02:30 UTC), Completed: 10:30 AM IST (05:00 UTC) -> 150m delay, LATE
    console.log("\n[3] Setting up Medication and Critical Acceptance Dose (150m Late)...");
    const medRes = await client.query(
      `
      INSERT INTO medications (
        user_id, patient_code, medication_name, medication_type, dose_per_intake,
        frequency, medication_schedule, food_frequency, start_date, unit,
        total_quantity, daily_consumption
      ) VALUES (
        $1, $2, 'Metformin 500mg', 'TABLET', 1,
        'Once Daily', '{"Morning":"08:00:00"}', 'AFTER_FOOD', '2026-10-21 00:00:00', 'TABLET',
        30, 1
      ) RETURNING id;
    `,
      [testUserId, patientCode],
    );
    testMedicationId = medRes.rows[0].id;

    const remRes = await client.query(
      `
      INSERT INTO medication_reminders (
        patient_id, medication_id, dose_per_intake
      ) VALUES ($1, $2, 1) RETURNING id;
    `,
      [testUserId, testMedicationId],
    );
    const reminderId = remRes.rows[0].id;

    const scheduledUtc = new Date("2026-10-21T02:30:00.000Z");
    const completedUtc = new Date("2026-10-21T05:00:00.000Z");

    await client.query(
      `
      INSERT INTO medication_reminder_occurrences (
        patient_id, medication_id, reminder_id,
        actual_medication_time, status, completion_classification,
        completed_at, delay_minutes, is_overdue
      ) VALUES (
        $1, $2, $3, $4, 'COMPLETED', 'LATE', $5, 150, false
      );
    `,
      [testUserId, testMedicationId, reminderId, scheduledUtc, completedUtc],
    );

    // 4. Start Real Express HTTP Server on Ephemeral Port
    console.log("\n[4] Starting Express HTTP Server...");
    const app = require("../../src/server");
    server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`   Express test instance listening at: ${baseUrl}`);

    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    // 5. Test Exact Effective Route URLs via HTTP
    console.log("\n[5] Executing HTTP Requests against Effective Routes...");

    // Route 1: Weekly Dashboard
    const weeklyUrl = `${baseUrl}/medication-reminders/dashboard/weekly`;
    console.log(`   -> GET ${weeklyUrl}?timezone=Asia/Kolkata`);
    const weeklyRes = await axios.get(weeklyUrl, {
      headers: authHeaders,
      params: { timezone: "Asia/Kolkata", startDate: "2026-10-15", endDate: "2026-10-21" },
    });
    console.log(`   Status: ${weeklyRes.status} ${weeklyRes.statusText}`);
    console.log("   Response envelope:", weeklyRes.data.status);
    if (
      weeklyRes.data.status?.status !== "SUCCESS" ||
      weeklyRes.data.data.kpiSummary.completedLate !== 1
    ) {
      throw new Error(`Weekly HTTP response invalid: ${JSON.stringify(weeklyRes.data)}`);
    }
    console.log("   ✓ Weekly adherence HTTP endpoint verified.");

    // Route 2: Monthly Dashboard
    const monthlyUrl = `${baseUrl}/medication-reminders/dashboard/monthly`;
    console.log(`\n   -> GET ${monthlyUrl}?timezone=Asia/Kolkata&month=10&year=2026`);
    const monthlyRes = await axios.get(monthlyUrl, {
      headers: authHeaders,
      params: { timezone: "Asia/Kolkata", month: 10, year: 2026 },
    });
    console.log(`   Status: ${monthlyRes.status} ${monthlyRes.statusText}`);
    console.log("   Percentages:", monthlyRes.data.data.percentages);
    if (
      monthlyRes.data.status?.status !== "SUCCESS" ||
      monthlyRes.data.data.percentages.lateCompletion !== 100
    ) {
      throw new Error(`Monthly HTTP response invalid: ${JSON.stringify(monthlyRes.data)}`);
    }
    console.log("   ✓ Monthly adherence HTTP endpoint verified.");

    // Route 3: Daily Details
    const dailyUrl = `${baseUrl}/medication-reminders/dashboard/daily-details`;
    console.log(`\n   -> GET ${dailyUrl}?timezone=Asia/Kolkata&date=2026-10-21`);
    const dailyRes = await axios.get(dailyUrl, {
      headers: authHeaders,
      params: { timezone: "Asia/Kolkata", date: "2026-10-21" },
    });
    console.log(`   Status: ${dailyRes.status} ${dailyRes.statusText}`);
    const dose = dailyRes.data.data.doses[0];
    console.log("   Dose details:", {
      medicationName: dose.medicationName,
      delayMinutes: dose.delayMinutes,
      delayFormatted: dose.delayFormatted,
      status: dose.status,
      completionClassification: dose.completionClassification,
    });
    if (
      dose.delayMinutes !== 150 ||
      dose.delayFormatted !== "2h 30m late" ||
      dose.completionClassification !== "LATE"
    ) {
      throw new Error(`Daily details dose delay invalid: ${JSON.stringify(dose)}`);
    }
    console.log("   ✓ Daily details HTTP endpoint verified with 150m delay.");

    // Route 4: Refill Alerts with 30 units (Healthy stock)
    const refillsUrl = `${baseUrl}/medication-reminders/dashboard/refills`;
    console.log(`\n   -> GET ${refillsUrl}?timezone=Asia/Kolkata`);
    const refillsHealthyRes = await axios.get(refillsUrl, {
      headers: authHeaders,
      params: { timezone: "Asia/Kolkata" },
    });
    console.log(`   Status: ${refillsHealthyRes.status} ${refillsHealthyRes.statusText}`);
    console.log("   Healthy stock result:", refillsHealthyRes.data.data);
    if (refillsHealthyRes.data.data.hasRefillAlerts !== false) {
      throw new Error("Refill alerts expected false for 30 units healthy stock");
    }
    console.log("   ✓ Refills endpoint correctly omits section when stock is healthy.");

    // 6. Test Refill Accuracy, Audit Ledger & Inventory Verification
    console.log("\n[6] Testing Refill Inventory Verification & Double-Count Prevention...");
    // Drop medication stock to 5 units
    await client.query(`UPDATE medications SET total_quantity = 5 WHERE id = $1;`, [
      testMedicationId,
    ]);

    // Query refills without refill history
    const refillsUnverified = await axios.get(refillsUrl, {
      headers: authHeaders,
      params: { timezone: "Asia/Kolkata" },
    });
    const unverifiedMed = refillsUnverified.data.data.medications[0];
    console.log("   Low-stock alert without refill history:", {
      medicationName: unverifiedMed.medicationName,
      urgency: unverifiedMed.urgency,
      isVerifiedInventory: unverifiedMed.isVerifiedInventory,
      hasRefillHistory: unverifiedMed.hasRefillHistory,
    });
    if (unverifiedMed.isVerifiedInventory !== false || unverifiedMed.hasRefillHistory !== false) {
      throw new Error(
        "Stock must NOT be labeled verified without an explicit confirmation/refill record!",
      );
    }
    console.log("   ✓ Unverified stock correctly labeled as isVerifiedInventory: false.");

    // Now insert an explicit refill confirmation record into refill_count
    console.log("\n   Recording explicit refill transaction in refill_count ledger...");
    await client.query(
      `
      INSERT INTO refill_count (
        user_id, medication_id, before_refill_total_quantity, before_refill_remaining_quantity,
        refill_quantity, after_refill_total_quantity, after_refill_remaining_quantity
      ) VALUES (
        $1, $2, 5, 4, 30, 35, 34
      );
    `,
      [testUserId, testMedicationId],
    );

    // Query refills with refill history
    const refillsVerified = await axios.get(refillsUrl, {
      headers: authHeaders,
      params: { timezone: "Asia/Kolkata" },
    });
    const verifiedMed = refillsVerified.data.data.medications[0];
    console.log("   Low-stock alert WITH explicit refill history:", {
      medicationName: verifiedMed.medicationName,
      isVerifiedInventory: verifiedMed.isVerifiedInventory,
      hasRefillHistory: verifiedMed.hasRefillHistory,
    });
    if (verifiedMed.isVerifiedInventory !== true || verifiedMed.hasRefillHistory !== true) {
      throw new Error(
        "Stock must be labeled isVerifiedInventory: true when explicit confirmation record exists!",
      );
    }
    console.log(
      "   ✓ Verified stock correctly marked isVerifiedInventory: true after refill record.",
    );

    // 7. Security and Validation Verification over HTTP
    console.log("\n[7] Testing HTTP Security & Validation Boundaries...");
    // 401 Unauthorized check
    try {
      await axios.get(weeklyUrl, { params: { timezone: "Asia/Kolkata" } });
      throw new Error("Expected 401 without auth token!");
    } catch (err) {
      if (err.response && err.response.status === 401) {
        console.log("   ✓ Unauthenticated request rejected with 401 Unauthorized.");
      } else {
        throw err;
      }
    }

    // 400 Bad Request check (invalid month query parameter)
    try {
      await axios.get(monthlyUrl, {
        headers: authHeaders,
        params: { timezone: "Asia/Kolkata", month: 13, year: 2026 },
      });
      throw new Error("Expected 400 with invalid month query!");
    } catch (err) {
      if (err.response && err.response.status === 400) {
        console.log("   ✓ Invalid query parameter rejected with 400 Bad Request.");
      } else {
        throw err;
      }
    }

    // 8. Clean up
    console.log("\n[8] Cleaning up test records...");
    await client.query("DELETE FROM refill_count WHERE user_id = $1;", [testUserId]);
    await client.query("DELETE FROM medication_reminder_occurrences WHERE patient_id = $1;", [
      testUserId,
    ]);
    await client.query("DELETE FROM medication_reminders WHERE patient_id = $1;", [testUserId]);
    await client.query("DELETE FROM medications WHERE user_id = $1;", [testUserId]);
    await client.query("DELETE FROM sessions WHERE user_id = $1;", [testUserId]);
    await client.query("DELETE FROM patients WHERE id = $1;", [testUserId]);
    console.log("   Cleanup complete.");

    console.log("\n=== ALL HTTP INTEGRATION TESTS PASSED 100% ===");
  } finally {
    if (server) {
      server.close();
    }
    await client.end();
  }
}

runHttpIntegrationTest().catch((err) => {
  console.error("\nHTTP Integration Test Failed:", err);
  process.exit(1);
});
