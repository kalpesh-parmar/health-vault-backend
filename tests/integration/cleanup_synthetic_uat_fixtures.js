const { db, pool } = require("../../src/configs/db");
const { document } = require("../../src/models/document");
const { patientLabResult } = require("../../src/models/patientLabResult");
const { patient } = require("../../src/models/patient");
const { inArray, eq } = require("drizzle-orm");

async function cleanupSyntheticFixtures() {
  console.log("================================================================================");
  console.log("HEALTH VAULT v8.2: SYNTHETIC UAT TEST FIXTURE CLEANUP");
  console.log("================================================================================\n");

  // 1. Identify synthetic documents by strict s3Key filter
  const targetS3Keys = [
    "uat_v82_report_a.pdf",
    "uat_v82_report_b.pdf",
    "uat_v82_report_deleted.pdf",
  ];

  const targetDocs = await db
    .select({
      id: document.id,
      fileName: document.fileName,
      s3Key: document.s3Key,
      userId: document.userId,
    })
    .from(document)
    .where(inArray(document.s3Key, targetS3Keys));

  console.log(`--> Positively identified ${targetDocs.length} synthetic test document(s):`);
  targetDocs.forEach((d) =>
    console.log(`    - ID: ${d.id} | Name: ${d.fileName} | s3Key: ${d.s3Key}`),
  );

  let deletedLabCount = 0;
  let deletedDocCount = 0;

  if (targetDocs.length > 0) {
    const docIds = targetDocs.map((d) => d.id);

    // 2. Delete synthetic patient_lab_results strictly for these document IDs
    const deletedLabs = await db
      .delete(patientLabResult)
      .where(inArray(patientLabResult.documentId, docIds))
      .returning({ id: patientLabResult.id });
    deletedLabCount = deletedLabs.length;
    console.log(`--> Safely removed ${deletedLabCount} synthetic patient_lab_results record(s).`);

    // 3. Delete synthetic document records
    const deletedDocs = await db
      .delete(document)
      .where(inArray(document.id, docIds))
      .returning({ id: document.id });
    deletedDocCount = deletedDocs.length;
    console.log(`--> Safely removed ${deletedDocCount} synthetic document record(s).`);
  } else {
    console.log("--> No synthetic documents found. Environment is already clean.");
  }

  // 4. Check if synthetic patient account exists (uat_v82_patient@healthvault.local)
  const syntheticPatients = await db
    .select({ id: patient.id, email: patient.email })
    .from(patient)
    .where(eq(patient.email, "uat_v82_patient@healthvault.local"));

  if (syntheticPatients.length > 0) {
    const pId = syntheticPatients[0].id;
    await db.delete(patient).where(eq(patient.id, pId));
    console.log(`--> Removed synthetic test patient account: ${pId}`);
  }

  console.log("\n================================================================================");
  console.log("SYNTHETIC FIXTURE CLEANUP COMPLETED SAFELY WITHOUT AFFECTING USER DATA.");
  console.log("================================================================================\n");

  return {
    deletedLabCount,
    deletedDocCount,
    targetDocs,
  };
}

if (require.main === module) {
  cleanupSyntheticFixtures()
    .catch((err) => {
      console.error("Cleanup error:", err);
      process.exit(1);
    })
    .finally(async () => {
      await pool.end().catch(() => {});
    });
}

module.exports = { cleanupSyntheticFixtures };
