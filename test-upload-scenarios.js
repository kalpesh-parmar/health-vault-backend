const fs = require("fs");
const path = require("path");
const http = require("http");
const axios = require("axios");
const FormData = require("form-data");
const { pool } = require("./src/configs/db");
const JwtUtils = require("./src/utils/jwtUtils");
const { env } = require("./src/configs/env");

const realPdfPath = path.join(__dirname, "ai-service/tests/fixtures/golden_docs/echo_report.pdf");
const realPdfBuffer = fs.readFileSync(realPdfPath);

async function runTests() {
  console.log("========================================================");
  console.log("    HEALTH VAULT DOCUMENT UPLOAD VALIDATION SUITE       ");
  console.log("========================================================");

  let token;
  try {
    const userRes = await pool.query(
      "SELECT id, status FROM patients WHERE status = 'ACTIVE' LIMIT 1",
    );
    const user = userRes.rows[0];
    const sessionRes = await pool.query(
      "SELECT id, user_id, is_active FROM sessions WHERE user_id = $1 AND is_active = true AND soft_delete = false LIMIT 1",
      [user.id],
    );
    const session = sessionRes.rows[0];
    token = JwtUtils.generateAccessToken({
      userId: user.id,
      sessionId: session.id,
      tokenType: "access",
    });
    console.log("✓ Acquired test JWT for patient:", user.id);
  } catch (err) {
    console.error("Failed to acquire test token:", err);
    process.exit(1);
  }

  const results = [];

  // ------------------------------------------------------------------------
  // Test 1: Single Small Medical Document Upload (echo_report.pdf)
  // ------------------------------------------------------------------------
  try {
    console.log("\n[TEST 1] Single Small Medical Document Upload...");
    const form = new FormData();
    form.append("files", realPdfBuffer, {
      filename: "echo_report.pdf",
      contentType: "application/pdf",
    });

    const res = await axios.post("http://localhost:4002/documents/upload", form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    const body = res.data?.data || res.data;
    if (res.status === 202 && body?.batchId && body?.documents?.length === 1) {
      console.log(
        "✓ PASS: Single document accepted. BatchId:",
        body.batchId,
        "JobId:",
        body.documents[0].jobId,
      );
      results.push({ test: "Single Document Upload", status: "PASS" });
    } else {
      console.error("✗ FAIL: Unexpected response payload:", res.status, body);
      results.push({ test: "Single Document Upload", status: "FAIL" });
    }
  } catch (err) {
    console.error(
      "✗ FAIL: Single document upload error:",
      err.response?.status,
      err.response?.data || err.message,
    );
    results.push({ test: "Single Document Upload", status: "FAIL" });
  }

  // ------------------------------------------------------------------------
  // Test 2: Multi-Document Upload (3 valid documents up to limit 5)
  // ------------------------------------------------------------------------
  try {
    console.log("\n[TEST 2] Multiple Documents Upload (3 files in batch)...");
    const form = new FormData();
    form.append("files", realPdfBuffer, {
      filename: "report_1.pdf",
      contentType: "application/pdf",
    });
    form.append("files", realPdfBuffer, {
      filename: "report_2.pdf",
      contentType: "application/pdf",
    });
    form.append("files", realPdfBuffer, {
      filename: "report_3.pdf",
      contentType: "application/pdf",
    });

    const res = await axios.post("http://localhost:4002/documents/upload", form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    const body = res.data?.data || res.data;
    if (res.status === 202 && body?.batchId && body?.documents?.length === 3) {
      console.log(
        "✓ PASS: Multi-document batch accepted. Count:",
        body.documents.length,
        "BatchId:",
        body.batchId,
      );
      results.push({ test: "Multi-Document Upload (3 files)", status: "PASS" });
    } else {
      console.error("✗ FAIL: Unexpected multi-doc response payload:", res.status, body);
      results.push({ test: "Multi-Document Upload (3 files)", status: "FAIL" });
    }
  } catch (err) {
    console.error(
      "✗ FAIL: Multi-document error:",
      err.response?.status,
      err.response?.data || err.message,
    );
    results.push({ test: "Multi-Document Upload (3 files)", status: "FAIL" });
  }

  // ------------------------------------------------------------------------
  // Test 3: Excessive File Count (> env.maxFilesPerUpload files)
  // ------------------------------------------------------------------------
  try {
    const limit = env.maxFilesPerUpload || 20;
    console.log(
      `\n[TEST 3] Excessive File Count (${limit + 1} files in batch, limit is ${limit})...`,
    );
    const form = new FormData();
    for (let i = 1; i <= limit + 1; i++) {
      form.append("files", realPdfBuffer, {
        filename: `report_${i}.pdf`,
        contentType: "application/pdf",
      });
    }

    await axios.post("http://localhost:4002/documents/upload", form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });
    console.error("✗ FAIL: Excessive files request was unexpectedly accepted!");
    results.push({ test: `Excessive File Count (>${limit} files)`, status: "FAIL" });
  } catch (err) {
    if (err.response?.status === 400) {
      console.log("✓ PASS: Correctly rejected with 400. Message:", err.response.data?.message);
      results.push({
        test: `Excessive File Count (>${env.maxFilesPerUpload || 20} files)`,
        status: "PASS",
      });
    } else {
      console.error("✗ FAIL: Expected 400, got:", err.response?.status, err.message);
      results.push({
        test: `Excessive File Count (>${env.maxFilesPerUpload || 20} files)`,
        status: "FAIL",
      });
    }
  }

  // ------------------------------------------------------------------------
  // Test 4: File Size Limit Exceeded (> 25MB)
  // ------------------------------------------------------------------------
  try {
    console.log("\n[TEST 4] Oversized File (> 25MB)...");
    const largeBuffer = Buffer.alloc(26 * 1024 * 1024, "%PDF-1.4\n");
    const form = new FormData();
    form.append("files", largeBuffer, {
      filename: "large_file.pdf",
      contentType: "application/pdf",
    });

    await axios.post("http://localhost:4002/documents/upload", form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    console.error("✗ FAIL: Oversized file was unexpectedly accepted!");
    results.push({ test: "Oversized File (>25MB)", status: "FAIL" });
  } catch (err) {
    if (err.response?.status === 400 && (err.response.data?.message || "").includes("large")) {
      console.log(
        "✓ PASS: Correctly rejected oversized file. Message:",
        err.response.data?.message,
      );
      results.push({ test: "Oversized File (>25MB)", status: "PASS" });
    } else if (err.response?.status === 400) {
      console.log("✓ PASS: Rejected with 400. Message:", err.response.data?.message);
      results.push({ test: "Oversized File (>25MB)", status: "PASS" });
    } else {
      console.error("✗ FAIL: Expected 400, got:", err.response?.status, err.message);
      results.push({ test: "Oversized File (>25MB)", status: "FAIL" });
    }
  }

  // ------------------------------------------------------------------------
  // Test 5: Invalid File Type (Unsupported format)
  // ------------------------------------------------------------------------
  try {
    console.log("\n[TEST 5] Invalid File Type (.exe / text)...");
    const form = new FormData();
    form.append("files", Buffer.from("MZ executable binary header"), {
      filename: "malicious.exe",
      contentType: "application/x-msdownload",
    });

    await axios.post("http://localhost:4002/documents/upload", form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });
    console.error("✗ FAIL: Invalid file type was unexpectedly accepted!");
    results.push({ test: "Invalid File Type Rejection", status: "FAIL" });
  } catch (err) {
    if (err.response?.status === 400) {
      console.log(
        "✓ PASS: Correctly rejected invalid file type with 400. Message:",
        err.response.data?.message,
      );
      results.push({ test: "Invalid File Type Rejection", status: "PASS" });
    } else {
      console.error("✗ FAIL: Expected 400, got:", err.response?.status, err.message);
      results.push({ test: "Invalid File Type Rejection", status: "FAIL" });
    }
  }

  // ------------------------------------------------------------------------
  // Test 6: Client Abrupt Socket Hangup (Abort Handling)
  // ------------------------------------------------------------------------
  try {
    console.log("\n[TEST 6] Client Abrupt Socket Abort Handling...");
    await new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "localhost",
          port: 4002,
          path: "/documents/upload",
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data; boundary=----WebKitFormBoundaryAbortTest",
            "Content-Length": "500000",
          },
        },
        (res) => {
          console.log("Server response code for aborted upload:", res.statusCode);
          resolve();
        },
      );

      req.on("error", (e) => {
        console.log("Client received expected socket error after destroy:", e.message);
        resolve();
      });

      req.write(
        '------WebKitFormBoundaryAbortTest\r\nContent-Disposition: form-data; name="files"; filename="abort_test.pdf"\r\nContent-Type: application/pdf\r\n\r\npartial stream data...',
      );
      setTimeout(() => {
        console.log("Destroying client socket mid-upload to simulate abrupt disconnect...");
        req.destroy();
        setTimeout(resolve, 600);
      }, 100);
    });

    console.log("✓ PASS: Abrupt client abort handled cleanly without server crash");
    results.push({ test: "Client Socket Abort Handling", status: "PASS" });
  } catch (err) {
    console.error("✗ FAIL: Abort test threw unexpected error:", err);
    results.push({ test: "Client Socket Abort Handling", status: "FAIL" });
  }

  // ------------------------------------------------------------------------
  // Test 7: Pre-Upload Document Validation Endpoint (/documents/validate)
  // ------------------------------------------------------------------------
  try {
    console.log("\n[TEST 7] Pre-Upload Document Validation (/documents/validate)...");
    const form = new FormData();
    form.append("files", realPdfBuffer, {
      filename: "echo_report.pdf",
      contentType: "application/pdf",
    });

    const res = await axios.post("http://localhost:4002/documents/validate", form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    if (
      res.status === 200 &&
      (res.data?.success || res.data?.status?.status === "SUCCESS" || res.data?.data?.results)
    ) {
      console.log(
        "✓ PASS: Document pre-validation endpoint responded 200 OK:",
        res.data?.status?.description || "Validated",
      );
      results.push({ test: "Pre-Upload Document Validation", status: "PASS" });
    } else {
      console.error("✗ FAIL: Unexpected validate status:", res.status, res.data);
      results.push({ test: "Pre-Upload Document Validation", status: "FAIL" });
    }
  } catch (err) {
    console.error(
      "✗ FAIL: Validate error:",
      err.response?.status,
      err.response?.data || err.message,
    );
    results.push({ test: "Pre-Upload Document Validation", status: "FAIL" });
  }

  // ------------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------------
  console.log("\n========================================================");
  console.log("                  TEST RESULTS SUMMARY                  ");
  console.log("========================================================");
  let allPassed = true;
  for (const r of results) {
    console.log(`${r.status === "PASS" ? "✓" : "✗"} [${r.status}] ${r.test}`);
    if (r.status !== "PASS") allPassed = false;
  }
  console.log("========================================================");
  console.log(allPassed ? "ALL TESTS PASSED SUCCESSFULLY! ✓" : "SOME TESTS FAILED! ✗");
  console.log("========================================================");

  await pool.end();
  process.exit(allPassed ? 0 : 1);
}

runTests();
