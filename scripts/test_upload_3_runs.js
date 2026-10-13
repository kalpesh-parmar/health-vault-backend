const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const axios = require("axios");

const { db } = require("../src/configs/db");
const { patient } = require("../src/models/patient");
const { session } = require("../src/models/session");
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
      refreshTokenHash: "investigation-test-hash-" + Date.now(),
      refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      isActive: true,
      userAgent: "Investigation-Client/1.0",
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
  console.log(`>>> CLIENT CALLING POST /documents/upload [RUN ${runIndex}]`);
  console.log(`========================================================================`);

  const baseBuf = fs.readFileSync(FIXTURE_PATH);
  const freshBuf = Buffer.concat([
    baseBuf,
    Buffer.from(`\n% FRESH_SHA_${Date.now()}_${Math.random()}_RUN_${runIndex}\n`),
  ]);

  const form = new FormData();
  form.append("files", freshBuf, {
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
      `>>> CLIENT RUN ${runIndex} FINISHED IN ${tElapsed}ms with status ${response.status}`,
    );
    console.log(`>>> Response data:`, JSON.stringify(response.data));
    return { runIndex, success: true, elapsedMs: tElapsed };
  } catch (error) {
    const tElapsed = Date.now() - tStart;
    console.error(
      `>>> CLIENT RUN ${runIndex} FAILED IN ${tElapsed}ms:`,
      error.response?.data || error.message,
    );
    return { runIndex, success: false, elapsedMs: tElapsed };
  }
}

async function main() {
  const { patientId, token } = await setupAuth();
  console.log(`Authenticated as patient: ${patientId}`);

  for (let i = 1; i <= 3; i++) {
    await runUpload(i, token);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
