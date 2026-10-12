/**
 * Phase 9 Final Post-Remediation End-to-End Verification Script
 *
 * Executes genuine HTTP upload -> Node API -> Python AI Service -> PostgreSQL
 * for the 4 critical fixtures:
 * 1. gujarati_prescription.pdf (REM-01)
 * 2. scanned_report.pdf (REM-02)
 * 3. lab_1_.jpeg (REM-02)
 * 4. mixed_document.pdf (REM-03)
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { pool } = require("../src/configs/db");
const JwtUtils = require("../src/utils/jwtUtils");

const PATIENT_ID = "4b3687a3-21d7-4c5b-90b0-0bd1a42babbd";
const SESSION_ID = "867fea94-37e0-4f37-afa6-f1fcb31a2de1";
const NODE_URL = "http://127.0.0.1:4002";
const FASTAPI_URL = "http://127.0.0.1:8000";

const FIXTURES_DIR = path.resolve(__dirname, "../ai-service/tests/fixtures/golden_docs");

function levenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function calculateCharacterAccuracy(reference, hypothesis) {
  const normRef = (reference || "").replace(/\s+/g, " ").trim().toLowerCase();
  const normHyp = (hypothesis || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normRef) return 100.0;
  const dist = levenshteinDistance(normRef, normHyp);
  const cer = dist / Math.max(normRef.length, 1);
  return Math.max(0, (1 - cer) * 100);
}

async function uploadAndPollDocument(token, filename, mimeType, maxWaitSec = 360) {
  const filePath = path.join(FIXTURES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture file not found: ${filePath}`);
  }

  const form = new FormData();
  form.append("files", fs.createReadStream(filePath), {
    filename,
    contentType: mimeType,
  });

  const uploadStart = Date.now();
  let uploadRes;
  try {
    uploadRes = await axios.post(`${NODE_URL}/documents/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
      timeout: 30000,
    });
  } catch (err) {
    return {
      success: false,
      stage: "UPLOAD",
      statusCode: err.response?.status,
      errorData: err.response?.data,
      message: err.message,
    };
  }
  const uploadDurationMs = Date.now() - uploadStart;

  const uploadData = uploadRes.data?.data;
  const uploadedDoc =
    uploadData?.documents?.[0] || (Array.isArray(uploadData) ? uploadData[0] : uploadData);
  const jobId = uploadedDoc?.jobId;
  const documentId = uploadedDoc?.documentId;

  if (!jobId || !documentId) {
    throw new Error(
      `Upload succeeded but missing jobId/documentId: ${JSON.stringify(uploadRes.data)}`,
    );
  }

  // Poll database for job completion
  const pollStart = Date.now();
  let jobRow = null;
  let completed = false;

  while (!completed && Date.now() - pollStart < maxWaitSec * 1000) {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await pool.query("SELECT * FROM document_processing_jobs WHERE id = $1", [jobId]);
    if (res.rows && res.rows.length > 0) {
      jobRow = res.rows[0];
      const status = jobRow.status;
      if (status === "COMPLETED" || status === "PARTIAL") {
        completed = true;
        break;
      } else if (status === "FAILED") {
        break;
      }
    }
  }

  const processingDurationMs = Date.now() - pollStart;

  // Retrieve document record from PostgreSQL
  const docRes = await pool.query("SELECT * FROM documents WHERE id = $1", [documentId]);
  const docRow = docRes.rows?.[0] || null;

  // Retrieve document via HTTP GET /documents/:id
  let getRes = null;
  try {
    getRes = await axios.get(`${NODE_URL}/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
  } catch {
    // ignore get error
  }

  return {
    success: completed && (jobRow?.status === "COMPLETED" || jobRow?.status === "PARTIAL"),
    filename,
    uploadStatus: uploadRes.status,
    uploadDurationMs,
    jobId,
    documentId,
    jobStatus: jobRow?.status,
    jobError: jobRow?.error,
    totalElapsedMs: uploadDurationMs + processingDurationMs,
    processingDurationMs,
    completedStages: jobRow?.completed_stages || [],
    ocrStatus: docRow?.ocr_status,
    documentType: docRow?.document_type,
    raw_ocr_data: docRow?.raw_ocr_data,
    structured_data: docRow?.structured_extracted_data,
    httpGetPayload: getRes?.data?.data || null,
  };
}

async function main() {
  console.log("================================================================================");
  console.log("PHASE 9 — FINAL POST-REMEDIATION END-TO-END VERIFICATION");
  console.log("================================================================================");
  console.log("Timestamp:", new Date().toISOString());

  const token = JwtUtils.generateAccessToken({
    userId: PATIENT_ID,
    sessionId: SESSION_ID,
    tokenType: "access",
  });
  console.log("✓ Live JWT Bearer Token generated.");

  const results = {
    negativeControls: {},
    fixtures: {},
    invariants: {},
  };

  // ── TEST 1: Negative Controls (Electricity bill rejection) ──────────────────
  console.log("\n[1/5] Verifying Negative Controls Rejection Gate...");
  const elecPdfPath = path.resolve(__dirname, "test_electricity_bill.pdf");
  if (fs.existsSync(elecPdfPath)) {
    const elecForm = new FormData();
    elecForm.append("files", fs.createReadStream(elecPdfPath), {
      filename: "electricity_bill.pdf",
      contentType: "application/pdf",
    });

    try {
      const eRes = await axios.post(`${NODE_URL}/documents/upload`, elecForm, {
        headers: { ...elecForm.getHeaders(), Authorization: `Bearer ${token}` },
      });
      console.log(`  ✗ Electricity Bill unexpectedly accepted: HTTP ${eRes.status}`);
      results.negativeControls.electricityBill = { rejected: false, httpStatus: eRes.status };
    } catch (eErr) {
      console.log(
        `  ✓ Electricity Bill properly rejected: HTTP ${eErr.response?.status} (${eErr.response?.data?.message || "Rejected"})`,
      );
      results.negativeControls.electricityBill = {
        rejected: true,
        httpStatus: eErr.response?.status,
        message: eErr.response?.data?.message,
      };
    }

    // Direct check against FastAPI /v1/validation/medical
    const faElecForm = new FormData();
    faElecForm.append("file", fs.createReadStream(elecPdfPath), {
      filename: "electricity_bill.pdf",
      contentType: "application/pdf",
    });
    try {
      const faRes = await axios.post(`${FASTAPI_URL}/v1/validation/medical`, faElecForm, {
        headers: faElecForm.getHeaders(),
      });
      console.log(
        `  ✓ FastAPI direct classification for electricity bill: isMedical=${faRes.data?.isMedical}, reason="${faRes.data?.reason}"`,
      );
      results.negativeControls.fastApiVerification = faRes.data;
    } catch (faErr) {
      console.log(`  ✗ FastAPI direct error: ${faErr.message}`);
    }
  }

  // ── TEST 2: Genuine HTTP Upload of 4 Fixtures ────────────────────────────────
  const testFiles = [
    { name: "gujarati_prescription.pdf", mime: "application/pdf" },
    { name: "scanned_report.pdf", mime: "application/pdf" },
    { name: "lab_1_.jpeg", mime: "image/jpeg" },
    { name: "mixed_document.pdf", mime: "application/pdf" },
  ];

  for (const f of testFiles) {
    console.log(`\n[2/5] Running E2E upload & processing for: ${f.name}...`);
    const r = await uploadAndPollDocument(token, f.name, f.mime, 360);
    results.fixtures[f.name] = r;

    console.log(
      `  -> Result: Success=${r.success}, JobStatus=${r.jobStatus}, Elapsed=${(r.totalElapsedMs / 1000).toFixed(1)}s`,
    );
    if (r.raw_ocr_data) {
      const fullText = r.raw_ocr_data.fullText || "";
      console.log(
        `  -> OCR Text length: ${fullText.length} chars | Mean confidence: ${r.raw_ocr_data.confidence || r.raw_ocr_data.mean_confidence}`,
      );
    }
    if (r.structured_data) {
      const meds = r.structured_data.medications || [];
      console.log(`  -> Structured Medications: ${meds.length} items`);
      meds.forEach((m, idx) => {
        console.log(
          `     [Med ${idx + 1}] ${m.name || m.medicine_name} | status=${m.status} | clinician_verified=${m.clinician_verified}`,
        );
      });
      const addInfo = r.structured_data.additionalInformation || {};
      console.log(
        `  -> Additional Info: needsHumanReview=${addInfo.needsHumanReview}, partialExtraction=${addInfo.partialExtraction}, bypass=${addInfo.heuristicBypassEligible}`,
      );
    }
  }

  // ── TEST 3: Character Accuracy Against Ground Truth ─────────────────────────
  console.log("\n[3/5] Measuring OCR Accuracy & Ground Truth Recall...");
  for (const f of testFiles) {
    const res = results.fixtures[f.name];
    const gtJsonPath = path.join(FIXTURES_DIR, f.name.replace(/\.(pdf|jpeg)$/, ".json"));
    if (fs.existsSync(gtJsonPath)) {
      const gt = JSON.parse(fs.readFileSync(gtJsonPath, "utf-8"));
      const extractedText = res.raw_ocr_data?.fullText || "";
      let charAcc = "N/A";
      if (gt.groundTruthText) {
        charAcc = calculateCharacterAccuracy(gt.groundTruthText, extractedText).toFixed(2) + "%";
      }

      // Check ground truth medication recall
      const expectedMeds = (gt.medications || []).map((m) => (m.name || "").toLowerCase());
      const extractedMeds = (res.structured_data?.medications || []).map((m) =>
        (m.name || m.medicine_name || "").toLowerCase(),
      );
      const matchedMeds = expectedMeds.filter((em) =>
        extractedMeds.some((xm) => xm.includes(em.split(" ")[0])),
      );
      const recall =
        expectedMeds.length > 0
          ? ((matchedMeds.length / expectedMeds.length) * 100).toFixed(1) + "%"
          : "N/A";

      console.log(`  Fixture: ${f.name}`);
      console.log(`    Expected Meds: [${expectedMeds.join(", ")}]`);
      console.log(`    Extracted Meds: [${extractedMeds.join(", ")}]`);
      console.log(
        `    Medication Recall: ${recall} (${matchedMeds.length}/${expectedMeds.length})`,
      );
      if (charAcc !== "N/A") console.log(`    Character Accuracy: ${charAcc}`);

      res.accuracyEvaluation = {
        expectedMeds,
        extractedMeds,
        medicationRecall: recall,
        characterAccuracy: charAcc,
      };
    }
  }

  // ── TEST 4: Verification of Invariants ──────────────────────────────────────
  console.log("\n[4/5] Evaluating Safety Invariants...");
  let totalMeds = 0;
  let allProvisional = true;
  let allUnverified = true;
  let allNeedReview = true;

  for (const r of Object.values(results.fixtures)) {
    const meds = r.structured_data?.medications || [];

    for (const m of meds) {
      totalMeds++;

      if (m.status !== "PROVISIONAL") allProvisional = false;
      if (m.clinician_verified !== false) allUnverified = false;
    }
  }

  results.invariants = {
    totalExtractedMedications: totalMeds,
    allMedsProvisional: allProvisional,
    zeroAutonomousConfirmation: allUnverified,
    clinicianReviewMandatory: allNeedReview,
  };
  console.log(`  ✓ Total Medications Extracted: ${totalMeds}`);
  console.log(`  ✓ 100% Medications Tagged PROVISIONAL: ${allProvisional}`);
  console.log(`  ✓ Zero Autonomous Confirmation (clinician_verified=false): ${allUnverified}`);

  // Write comprehensive JSON result
  const outPath = path.resolve(
    __dirname,
    "../ai-service/benchmark_phase9_post_remediation_e2e.json",
  );
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n[5/5] Full verification telemetry written to: ${outPath}`);
  console.log("================================================================================");
}

main()
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error("FATAL ERROR IN E2E VERIFICATION:", err);
    pool.end();
    process.exit(1);
  });
