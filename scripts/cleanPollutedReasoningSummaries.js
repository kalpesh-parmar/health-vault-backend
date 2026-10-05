/**
 * Clean Polluted Reasoning Summaries (Phase 1, Commit D)
 *
 * Scans `documents` table for rows where `summaryInPreferredLanguage` or `summariesByLanguage`
 * contains reasoning leaks (<think>, Okay, let) or fails Indic script ratio validation.
 * Sets polluted fields to NULL so they can be cleanly regenerated on next access.
 *
 * Usage:
 *   node scripts/cleanPollutedReasoningSummaries.js          # Dry-run (default)
 *   node scripts/cleanPollutedReasoningSummaries.js --apply  # Apply changes to local DB
 *   node scripts/cleanPollutedReasoningSummaries.js --id=<uuid> [--apply]
 *
 * Safety:
 *   - Dry-run by default
 *   - Zero patient PII logged (only document ID and reason)
 *   - Local dev database only
 */

require("dotenv").config();
const { db } = require("../src/configs/db");
const { document } = require("../src/models/document");
const { eq } = require("drizzle-orm");
const { validateIndicScriptRatio } = require("../src/utils/textCleanUtils");

const POLLUTED_PATTERNS = [
  /<think\b/i,
  /<\/think>/i,
  /<thinking\b/i,
  /<\/thinking>/i,
  /<reasoning\b/i,
  /<\/reasoning>/i,
  /\bokay,\s*let/i,
];

function detectPollutionReason(text, targetLang) {
  if (!text || typeof text !== "string") return null;

  for (const pattern of POLLUTED_PATTERNS) {
    if (pattern.test(text)) {
      return `matches pattern ${pattern.toString()}`;
    }
  }

  const normLang = String(targetLang || "")
    .toLowerCase()
    .trim();
  if (normLang && normLang !== "english" && normLang !== "en") {
    if (!validateIndicScriptRatio(text, normLang)) {
      return `failed Indic script ratio validation for '${normLang}'`;
    }
  }

  return null;
}

async function cleanPollutedSummaries() {
  const args = process.argv.slice(2);
  const isApply = args.includes("--apply");
  const idArg = args.find((a) => a.startsWith("--id="));
  const targetId = idArg ? idArg.split("=")[1].trim() : null;

  console.log("=================================================");
  console.log("  Clean Polluted Reasoning Summaries Script");
  console.log(`  Mode: ${isApply ? "APPLY (writes to DB)" : "DRY-RUN (read-only preview)"}`);
  if (targetId) console.log(`  Target Document ID: ${targetId}`);
  console.log("=================================================\n");

  try {
    let docs = [];
    if (targetId) {
      docs = await db.select().from(document).where(eq(document.id, targetId));
    } else {
      docs = await db.select().from(document);
    }

    let scannedCount = 0;
    let pollutedCount = 0;
    let updatedCount = 0;

    for (const doc of docs) {
      scannedCount++;
      const structured = doc.structuredExtractedData;
      if (!structured || typeof structured !== "object") continue;

      let isPolluted = false;
      const reasons = [];

      const targetLang = structured.summaryLanguage || "english";

      // 1. Check summaryInPreferredLanguage
      if (structured.summaryInPreferredLanguage) {
        const reason = detectPollutionReason(structured.summaryInPreferredLanguage, targetLang);
        if (reason) {
          isPolluted = true;
          reasons.push(`summaryInPreferredLanguage: ${reason}`);
        }
      }

      // 2. Check summariesByLanguage
      if (structured.summariesByLanguage && typeof structured.summariesByLanguage === "object") {
        for (const [lang, trans] of Object.entries(structured.summariesByLanguage)) {
          const reason = detectPollutionReason(trans, lang);
          if (reason) {
            isPolluted = true;
            reasons.push(`summariesByLanguage.${lang}: ${reason}`);
          }
        }
      }

      // 3. Check structured.summary
      let isStructuredSummaryPolluted = false;
      if (structured.summary) {
        const reason = detectPollutionReason(structured.summary, "english");
        if (reason) {
          isPolluted = true;
          isStructuredSummaryPolluted = true;
          reasons.push(`structured.summary: ${reason}`);
        }
      }

      // 4. Check doc.summaryEnglish
      let isSummaryEnglishPolluted = false;
      if (doc.summaryEnglish) {
        const reason = detectPollutionReason(doc.summaryEnglish, "english");
        if (reason) {
          isPolluted = true;
          isSummaryEnglishPolluted = true;
          reasons.push(`summaryEnglish: ${reason}`);
        }
      }

      if (isPolluted) {
        pollutedCount++;
        console.log(`[POLLUTED] Document ID: ${doc.id}`);
        for (const r of reasons) {
          console.log(`  - Reason: ${r}`);
        }

        if (isApply) {
          const updatedStructured = { ...structured };
          updatedStructured.summaryInPreferredLanguage = null;
          if (isStructuredSummaryPolluted) {
            updatedStructured.summary = null;
          }
          if (updatedStructured.summariesByLanguage) {
            const cleanByLang = {};
            for (const [lang, trans] of Object.entries(updatedStructured.summariesByLanguage)) {
              if (!detectPollutionReason(trans, lang)) {
                cleanByLang[lang] = trans;
              }
            }
            updatedStructured.summariesByLanguage = cleanByLang;
          }
          updatedStructured.summaryPipelineVersion = null;

          const updatePayload = {
            structuredExtractedData: updatedStructured,
          };
          if (isSummaryEnglishPolluted) {
            updatePayload.summaryEnglish = null;
          }

          await db.update(document).set(updatePayload).where(eq(document.id, doc.id));

          updatedCount++;
          console.log(`  -> APPLIED: Reset summary fields to NULL for Document ID: ${doc.id}\n`);
        } else {
          console.log(
            `  -> DRY-RUN: Would reset summary fields to NULL for Document ID: ${doc.id}\n`,
          );
        }
      }
    }

    console.log("-------------------------------------------------");
    console.log(`Summary:`);
    console.log(`  Total scanned documents: ${scannedCount}`);
    console.log(`  Polluted documents found: ${pollutedCount}`);
    console.log(`  Documents updated:        ${updatedCount}`);
    console.log("-------------------------------------------------");

    if (!isApply && pollutedCount > 0) {
      console.log(
        "\nTo apply these changes, re-run with: node scripts/cleanPollutedReasoningSummaries.js --apply",
      );
    }
  } catch (err) {
    console.error("Cleanup failed:", err.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

if (require.main === module) {
  cleanPollutedSummaries();
}

module.exports = {
  detectPollutionReason,
  cleanPollutedSummaries,
};
