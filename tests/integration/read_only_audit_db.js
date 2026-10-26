const { db } = require("../../src/configs/db");
const { patient } = require("../../src/models/patient");
const { userOnboarding } = require("../../src/models/userOnboarding");
const { document } = require("../../src/models/document");
const { medication } = require("../../src/models/medication");
const { chatSession } = require("../../src/models/chatSession");
const { sql, eq } = require("drizzle-orm");

async function auditDb() {
  const patientId = "7fe9199f-1fc7-40b9-b618-54f03cbc7736";

  // 1. Patient record
  const patients = await db.select().from(patient).where(eq(patient.id, patientId));
  console.log("=== 1. PATIENT RECORD ===");
  console.log(JSON.stringify(patients[0], null, 2));

  // 2. User onboarding record
  const onboardings = await db
    .select()
    .from(userOnboarding)
    .where(eq(userOnboarding.userId, patientId));
  console.log("\n=== 2. USER ONBOARDING RECORD ===");
  console.log(JSON.stringify(onboardings[0], null, 2));

  // 3. Documents
  const docs = await db.select().from(document).where(eq(document.userId, patientId));
  console.log("\n=== 3. DOCUMENTS (Count: " + docs.length + ") ===");
  for (const d of docs) {
    console.log(
      `- ID: ${d.id}, File: "${d.fileName}", Type: ${d.documentType}, OCR: ${d.ocrStatus}, Date: ${d.reportDate}, Doctor: "${d.doctorName}"`,
    );
  }

  // 4. Medications
  const meds = await db.select().from(medication).where(eq(medication.userId, patientId));
  console.log("\n=== 4. ACTIVE MEDICATIONS (Count: " + meds.length + ") ===");
  for (const m of meds) {
    console.log(
      `- ID: ${m.id}, Name: "${m.medicationName}", Type: ${m.medicationType}, Frequency: ${m.frequency}, Ongoing: ${m.ongoing}, PrescribedBy: "${m.prescribedBy}", CreatedAt: ${m.createdAt}`,
    );
  }

  // 5. Patient relationships / family
  try {
    const tableCheck = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%relation%'`,
    );
    console.log("\n=== 5. RELATIONSHIP TABLES IN DB ===", tableCheck.rows || tableCheck);
  } catch (e) {
    console.log("Relationship table check note:", e.message);
  }

  // 6. Chat sessions & message count
  const sessions = await db.select().from(chatSession).where(eq(chatSession.userId, patientId));
  console.log("\n=== 6. CHAT SESSIONS (Count: " + sessions.length + ") ===");
  for (const s of sessions) {
    const msgCountRes = await db.execute(
      sql`SELECT count(*) as count FROM chat_messages WHERE session_id = ${s.id}`,
    );
    const count = (msgCountRes.rows || msgCountRes)[0]?.count;
    console.log(
      `- ID: ${s.id}, Type: ${s.metadata?.type}, Canonical: ${s.metadata?.isCanonical}, Title: "${s.title}", Messages: ${count}, Created: ${s.createdAt}, Updated: ${s.updatedAt}`,
    );
  }

  // 7. Structured Documents & Medical Entities (Provisional Extraction Status)
  try {
    const structDocs = await db.execute(
      sql`SELECT id, document_id, patient_id, created_at FROM structured_documents WHERE patient_id = ${patientId}`,
    );
    const rows = structDocs.rows || structDocs;
    console.log("\n=== 7. STRUCTURED DOCUMENTS (Count: " + rows.length + ") ===");
    for (const r of rows) {
      console.log(`- StructDoc ID: ${r.id}, Doc ID: ${r.document_id}`);
    }
  } catch (e) {
    console.log("Structured docs note:", e.message);
  }

  try {
    const entities = await db.execute(
      sql`SELECT id, document_id, entity_type, entity_value, confidence, is_verified FROM medical_entities WHERE patient_id = ${patientId} LIMIT 10`,
    );
    const entityRows = entities.rows || entities;
    console.log("\n=== 8. MEDICAL ENTITIES (Sample up to 10) ===");
    for (const ent of entityRows) {
      console.log(
        `- Type: ${ent.entity_type}, Value: "${ent.entity_value}", Confidence: ${ent.confidence}, Verified: ${ent.is_verified}`,
      );
    }
  } catch (e) {
    console.log("Medical entities note:", e.message);
  }

  process.exit(0);
}

auditDb().catch((e) => {
  console.error("Audit Error:", e);
  process.exit(1);
});
