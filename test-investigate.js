const fs = require("fs");
const path = require("path");
const http = require("http");
const axios = require("axios");
const FormData = require("form-data");
const { pool } = require("./src/configs/db");
const JwtUtils = require("./src/utils/jwtUtils");

async function main() {
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
    const token = JwtUtils.generateAccessToken({
      userId: user.id,
      sessionId: session.id,
      tokenType: "access",
    });
    console.log("Got test token for user:", user.id);

    // Test 1: Multipart with boundary (valid)
    console.log("\n--- Scenario A: Valid Multipart with Boundary ---");
    // Test 1: Multipart with boundary (valid) using real PDF
    console.log("\n--- Scenario A: Valid Multipart with Boundary (Local) ---");
    const realPdfPath = path.join(
      __dirname,
      "ai-service/tests/fixtures/golden_docs/echo_report.pdf",
    );
    const realPdfBuffer = fs.readFileSync(realPdfPath);

    const formA = new FormData();
    formA.append("files", realPdfBuffer, {
      filename: "file_1.pdf",
      contentType: "application/pdf",
    });
    formA.append("files", realPdfBuffer, {
      filename: "file_2.pdf",
      contentType: "application/pdf",
    });
    formA.append("files", realPdfBuffer, {
      filename: "file_3.pdf",
      contentType: "application/pdf",
    });
    try {
      const resA = await axios.post("http://localhost:4002/documents/upload", formA, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...formA.getHeaders(),
        },
      });
      console.log(
        "Scenario A status:",
        resA.status,
        "batchId:",
        resA.data?.data?.batchId || resA.data?.batchId,
      );
    } catch (err) {
      console.log("Scenario A error:", err.response?.status, err.response?.data || err.message);
    }

    // Test 2: Content-Type: multipart/form-data without boundary
    console.log("\n--- Scenario B: Content-Type: multipart/form-data WITHOUT boundary (Local) ---");
    const formB = new FormData();
    formB.append("files", realPdfBuffer, {
      filename: "echo_report.pdf",
      contentType: "application/pdf",
    });
    try {
      const resB = await axios.post("http://localhost:4002/documents/upload", formB, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "multipart/form-data",
        },
      });
      console.log("Scenario B status:", resB.status);
    } catch (err) {
      console.log("Scenario B error:", err.response?.status, err.response?.data || err.message);
    }

    // Test 2.5: ngrok URL test
    console.log("\n--- Scenario B2: Ngrok URL with real PDF ---");
    const formB2 = new FormData();
    formB2.append("files", realPdfBuffer, {
      filename: "echo_report.pdf",
      contentType: "application/pdf",
    });
    try {
      const resB2 = await axios.post(
        "https://subpectoral-strikingly-karin.ngrok-free.dev/documents/upload",
        formB2,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...formB2.getHeaders(),
            "ngrok-skip-browser-warning": "true",
          },
          timeout: 30000,
        },
      );
      console.log(
        "Scenario B2 Ngrok status:",
        resB2.status,
        "batchId:",
        resB2.data?.data?.batchId || resB2.data?.batchId,
      );
    } catch (err) {
      console.log(
        "Scenario B2 Ngrok error:",
        err.response?.status,
        err.response?.data || err.message,
      );
    }

    // Test 3: Abrupt client socket termination mid-stream
    console.log("\n--- Scenario C: Abrupt Client Socket Hangup (Abort) ---");
    await new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "localhost",
          port: 4002,
          path: "/documents/upload",
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data; boundary=----WebKitFormBoundaryX",
            "Content-Length": "100000",
          },
        },
        (res) => {
          console.log("Scenario C response status:", res.statusCode);
          resolve();
        },
      );

      req.on("error", (e) => {
        console.log("Scenario C client error received as expected:", e.message);
        resolve();
      });

      req.write(
        '------WebKitFormBoundaryX\r\nContent-Disposition: form-data; name="files"; filename="sample.pdf"\r\nContent-Type: application/pdf\r\n\r\npartial content...',
      );
      setTimeout(() => {
        console.log("Abruptly destroying socket while server expects 100000 bytes...");
        req.destroy();
        setTimeout(resolve, 500);
      }, 100);
    });
  } catch (err) {
    console.error("Fatal error:", err);
  } finally {
    await pool.end();
  }
}

main();
