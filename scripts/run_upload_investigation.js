const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const axios = require("axios");

const app = require("../src/server");
const { db } = require("../src/configs/db");
const { patient } = require("../src/models/patient");
const { session } = require("../src/models/session");
const { documentProcessingJob } = require("../src/models/documentProcessingJob");
const { eq } = require("drizzle-orm");
const { validationCache } = require("../src/services/cache/validationCache.service");
const JwtUtils = require("../src/utils/jwtUtils");

const PORT = 4002;
const FIXTURE_PATH = path.resolve(__dirname, "../tests/fixtures/golden_docs/5069200904.pdf");

async function setupAuth() {
  const [existingPatient] = await db.select().from(patient).limit(1);
  if (!existingPatient) {
    throw new Error("No patient found in database");
  }

  const [activeSession] = await db
    .insert(session)
    .values({
      userId: existingPatient.id,
      refreshTokenHash: "investigation-test-hash",
      refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      isActive: true,
      userAgent: "Investigation-Agent/1.0",
      ipAddress: "127.0.0.1",
    })
    .returning();

  const token = JwtUtils.generateAccessToken({
    userId: existingPatient.id,
    sessionId: activeSession.id,
    tokenType: "access",
  });

  return { patientId: existingPatient.id, sessionId: activeSession.id, token };
}

async function runUpload(runIndex, token) {
  console.log(`\n========================================================================`);
  console.log(`>>> STARTING UPLOAD RUN ${runIndex} WITH 5069200904.pdf`);
  console.log(`========================================================================`);

  const form = new FormData();
  form.append("files", fs.createReadStream(FIXTURE_PATH), {
    filename: "5069200904.pdf",
    contentType: "application/pdf",
  });

  const tStart = Date.now();
  try {
    const response = await axios.post(`http://localhost:${PORT}/documents/upload`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
      timeout: 120000,
    });
    const tElapsed = Date.now() - tStart;
    console.log(
      `>>> UPLOAD RUN ${runIndex} FINISHED IN ${tElapsed}ms with status ${response.status}`,
    );
    console.log(`>>> Response:`, JSON.stringify(response.data));
    return { runIndex, success: true, elapsedMs: tElapsed, data: response.data };
  } catch (error) {
    const tElapsed = Date.now() - tStart;
    console.error(
      `>>> UPLOAD RUN ${runIndex} FAILED IN ${tElapsed}ms:`,
      error.response?.data || error.message,
    );
    return {
      runIndex,
      success: false,
      elapsedMs: tElapsed,
      error: error.response?.data || error.message,
    };
  }
}

async function main() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture not found at ${FIXTURE_PATH}`);
  }

  const server = app.listen(PORT, async () => {
    console.log(`Investigation server listening on port ${PORT}`);
    try {
      const { patientId, token } = await setupAuth();
      console.log(`Authenticated as patient: ${patientId}`);

      const results = [];
      for (let i = 1; i <= 3; i++) {
        // Clear in-memory validation cache and previous SHA deduplication job
        // so Python service actually receives the document for each run
        // to evaluate cold vs warm model load!
        validationCache.clear();
        await db
          .delete(documentProcessingJob)
          .where(eq(documentProcessingJob.userId, patientId))
          .catch(() => {});

        const res = await runUpload(i, token);
        results.push(res);

        // Small pause between runs
        await new Promise((r) => setTimeout(r, 1000));
      }

      console.log(`\n========================================================================`);
      console.log(`>>> SUMMARY OF 3 RUNS:`);
      results.forEach((r) => {
        console.log(
          `Run ${r.runIndex}: ${r.elapsedMs}ms (Status: ${r.success ? "SUCCESS" : "FAILED"})`,
        );
      });
      console.log(`========================================================================\n`);
    } catch (err) {
      console.error("Investigation run failed:", err);
    } finally {
      server.close(() => {
        process.exit(0);
      });
    }
  });
}

main();
