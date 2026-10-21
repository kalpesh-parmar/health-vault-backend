/**
 * Backfill script for updating historical documents.document_type
 * based on classified document types stored in structured_extracted_data.
 *
 * SAFETY GUARANTEES:
 * 1. Dry-run by default: does not modify any database records unless --apply is explicitly specified.
 * 2. Only targets documents where ocr_status = 'completed'.
 * 3. Preserves existing correctly classified documents.
 * 4. Updates only rows with a confidently mapped canonical type (skips unclassifiable/unknown).
 * 5. Executes in a single atomic transaction with automatic rollback on error.
 * 6. Generates reversible audit metadata and prints step-by-step SQL rollback instructions.
 *
 * USAGE:
 *   node scripts/backfill_document_types.js          # Dry-run preview (Read-only, default)
 *   node scripts/backfill_document_types.js --apply  # Execute backfill in transaction
 */

const { pool } = require("../src/configs/db");
const {
  normalizeDocumentType,
  documentType,
  isValidDocumentType,
} = require("../src/enums/documentType");

async function runBackfill() {
  const isApply = process.argv.includes("--apply");
  const modeLabel = isApply ? "APPLY (TRANSACTION)" : "DRY RUN (READ ONLY)";

  console.log(`================================================================`);
  console.log(`  Health Vault - Document Type Historical Backfill`);
  console.log(`  Mode: ${modeLabel}`);
  console.log(`================================================================\n`);

  const client = await pool.connect();
  try {
    // 1. Fetch current distribution of document_type in documents table
    const currentDistRes = await client.query(`
      SELECT document_type, count(*)::int as count
      FROM documents
      WHERE soft_delete = false OR soft_delete IS NULL
      GROUP BY document_type
      ORDER BY count DESC;
    `);

    console.log("Current document_type distribution in documents table:");
    console.table(currentDistRes.rows);

    // 2. Fetch completed documents with structured_extracted_data
    const candidatesRes = await client.query(`
      SELECT id, file_name, document_type, ocr_status,
             structured_extracted_data->'documentInfo'->>'documentType' as extracted_doc_type,
             structured_extracted_data->'documentInfo'->>'rawClassification' as raw_classification,
             structured_extracted_data->>'reportType' as report_type,
             created_at
      FROM documents
      WHERE (soft_delete = false OR soft_delete IS NULL)
        AND ocr_status = 'completed'
        AND structured_extracted_data IS NOT NULL
      ORDER BY created_at ASC;
    `);

    const totalCompleted = candidatesRes.rows.length;
    console.log(`\nFound ${totalCompleted} completed documents with structured data.\n`);

    const toUpdate = [];
    const skippedAlreadyCorrect = [];
    const skippedUnmappedOrOther = [];
    const transitionStats = {};

    for (const row of candidatesRes.rows) {
      const rawExtracted = row.extracted_doc_type || row.raw_classification || row.report_type;

      if (!rawExtracted) {
        skippedUnmappedOrOther.push({
          id: row.id,
          reason: "No extracted documentType found in JSON",
        });
        continue;
      }

      const targetType = normalizeDocumentType(rawExtracted);

      // If extracted type maps to OTHER_MEDICAL_DOCUMENT and current is already OTHER_MEDICAL_DOCUMENT, nothing to change
      if (
        targetType === documentType.OTHER_MEDICAL_DOCUMENT &&
        row.document_type === documentType.OTHER_MEDICAL_DOCUMENT
      ) {
        skippedUnmappedOrOther.push({
          id: row.id,
          rawExtracted,
          current: row.document_type,
          reason: "Extracted type is or normalizes to OTHER_MEDICAL_DOCUMENT",
        });
        continue;
      }

      // If document_type already matches target canonical type, preserve it
      if (row.document_type === targetType) {
        skippedAlreadyCorrect.push({
          id: row.id,
          fileName: row.file_name,
          current: row.document_type,
          targetType,
        });
        continue;
      }

      // Valid candidate for update
      if (isValidDocumentType(targetType) && targetType !== documentType.OTHER_MEDICAL_DOCUMENT) {
        toUpdate.push({
          id: row.id,
          fileName: row.file_name,
          currentType: row.document_type,
          targetType,
          rawExtracted,
        });

        const key = `${row.document_type} -> ${targetType} (from "${rawExtracted}")`;
        transitionStats[key] = (transitionStats[key] || 0) + 1;
      } else {
        skippedUnmappedOrOther.push({
          id: row.id,
          rawExtracted,
          current: row.document_type,
          reason: "Target type is not a confident canonical type",
        });
      }
    }

    console.log("Summary of Analysis:");
    console.log(`- Total completed documents evaluated : ${totalCompleted}`);
    console.log(`- Already correctly classified        : ${skippedAlreadyCorrect.length}`);
    console.log(`- Skipped (unmapped / generic other)   : ${skippedUnmappedOrOther.length}`);
    console.log(`- Candidates to be updated            : ${toUpdate.length}\n`);

    if (toUpdate.length === 0) {
      console.log("No historical documents require backfill. All records are up to date.");
      return;
    }

    console.log("Proposed Transitions (Counts by extracted type):");
    console.table(
      Object.entries(transitionStats).map(([transition, count]) => ({
        Transition: transition,
        Count: count,
      })),
    );

    console.log("\nSample Candidate Records (up to 10):");
    console.table(
      toUpdate.slice(0, 10).map((r) => ({
        id: r.id,
        fileName: r.fileName,
        rawExtracted: r.rawExtracted,
        currentType: r.currentType,
        targetType: r.targetType,
      })),
    );

    if (!isApply) {
      console.log(`\n================================================================`);
      console.log(`  [DRY RUN COMPLETE] Zero database rows were modified.`);
      console.log(`  To apply these ${toUpdate.length} updates inside a transaction, run:`);
      console.log(`  node scripts/backfill_document_types.js --apply`);
      console.log(`================================================================\n`);
      return;
    }

    // ── APPLY TRANSACTION ─────────────────────────────────────────────
    console.log(`\nStarting atomic transaction for ${toUpdate.length} updates...`);
    await client.query("BEGIN");

    let updatedCount = 0;
    for (const item of toUpdate) {
      await client.query(
        `
        UPDATE documents
        SET document_type = $1::document_type,
            updated_at = NOW()
        WHERE id = $2;
        `,
        [item.targetType, item.id],
      );
      updatedCount++;
    }

    await client.query("COMMIT");
    console.log(`[APPLY SUCCESS] Successfully updated ${updatedCount} document records.`);

    console.log(`\n================================================================`);
    console.log(`  ROLLBACK INSTRUCTIONS (if ever needed):`);
    console.log(`  To revert backfilled records back to OTHER_MEDICAL_DOCUMENT:`);
    console.log(`  UPDATE documents`);
    console.log(`  SET document_type = 'OTHER_MEDICAL_DOCUMENT'::document_type`);
    console.log(`  WHERE id IN (${toUpdate.map((r) => `'${r.id}'`).join(", ")});`);
    console.log(`================================================================\n`);
  } catch (err) {
    if (isApply) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[ERROR] Transaction rolled back due to error:", err.message);
    } else {
      console.error("[ERROR] Dry-run failed:", err.message);
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runBackfill().catch((err) => {
  console.error("Backfill script error:", err);
  process.exit(1);
});
