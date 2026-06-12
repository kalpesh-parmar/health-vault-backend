/**
 * Sweeps expired extraction jobs every hour. Cron runs in-process.
 *
 * The sweeper deletes rows whose `expires_at` is in the past. The TTL is
 * 24 hours by default (set when the job is created). 24h is plenty for a
 * user to upload, extract, review, and confirm; anything older than that
 * is orphaned and safe to remove.
 */

const cron = require("node-cron");

const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");

const SCHEDULE = process.env.OCR_JOB_SWEEPER_CRON || "0 * * * *"; // top of every hour

cron.schedule(SCHEDULE, async () => {
  try {
    const removed = await documentProcessingJobRepository.sweepExpired();
    if (removed.length) {
      console.log(`[ocr-job-sweeper] removed ${removed.length} expired jobs`);
    }
  } catch (error) {
    console.error("[ocr-job-sweeper] sweep failed", error);
  }
});

module.exports = {};
