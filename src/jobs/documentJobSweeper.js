/**
 * Background sweepers for document extraction jobs.
 *
 * 1. Expired job sweeper: deletes rows past expires_at (TTL 24h) every hour.
 * 2. Stalled job sweeper: marks RUNNING jobs with stale heartbeats (> 15 mins) as FAILED (retryable) every 5 mins.
 */

const cron = require("node-cron");

const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");

const EXPIRED_SCHEDULE = process.env.OCR_JOB_SWEEPER_CRON || "0 * * * *"; // top of every hour
const STALLED_SCHEDULE = process.env.OCR_STALLED_SWEEPER_CRON || "*/5 * * * *"; // every 5 minutes
const DEFAULT_STALLED_CUTOFF_MINUTES = 15;

let expiredTask = null;
let stalledTask = null;

async function sweepExpiredJobs() {
  try {
    const removed = await documentProcessingJobRepository.sweepExpired();
    if (removed?.length) {
      console.log(`[ocr-job-sweeper] removed ${removed.length} expired jobs`);
    }
    return removed || [];
  } catch (error) {
    console.error("[ocr-job-sweeper] sweep expired jobs failed", error);
    return [];
  }
}

async function sweepStalledJobs(stalledCutoffMinutes = DEFAULT_STALLED_CUTOFF_MINUTES) {
  try {
    const cutoffDate = new Date(Date.now() - stalledCutoffMinutes * 60 * 1000);
    const failed = await documentProcessingJobRepository.failStalledRunningJobs(
      cutoffDate,
      `Job execution timed out without heartbeat (> ${stalledCutoffMinutes}m)`,
    );
    if (failed?.length) {
      console.log(`[ocr-job-sweeper] marked ${failed.length} stalled jobs as FAILED`);
    }
    return failed || [];
  } catch (error) {
    console.error("[ocr-job-sweeper] sweep stalled jobs failed", error);
    return [];
  }
}

function startSweeper() {
  stopSweeper();

  expiredTask = cron.schedule(EXPIRED_SCHEDULE, async () => {
    await sweepExpiredJobs();
  });

  stalledTask = cron.schedule(STALLED_SCHEDULE, async () => {
    await sweepStalledJobs();
  });
}

function stopSweeper() {
  if (expiredTask) {
    expiredTask.stop();
    expiredTask = null;
  }
  if (stalledTask) {
    stalledTask.stop();
    stalledTask = null;
  }
}

// Start sweeper when not running inside Jest test runner
if (process.env.NODE_ENV !== "test") {
  startSweeper();
}

module.exports = {
  sweepExpiredJobs,
  sweepStalledJobs,
  startSweeper,
  stopSweeper,
};
