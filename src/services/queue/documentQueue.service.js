/**
 * Durable Document Job Queue Service.
 *
 * Implements crash-safe, bounded-concurrency background job processing using
 * PostgreSQL as the durable source of truth (with optional Redis/BullMQ support).
 */

const { env } = require("../../configs/env");
const documentProcessingJobRepository = require("../../repositories/documentProcessingJobRepository");
const { ProgressEmitter } = require("../progressEmitter.service");
const { StageType } = require("../../enums/stageStatus");
const { DOCUMENT_STAGES } = require("../../constants/documentProgress.constants");

class DocumentQueueService {
  constructor() {
    this.concurrency = env.ocrConcurrency || 5;
    this.activeWorkers = 0;
    this.inMemoryQueue = [];
    this.heartbeatIntervalMs = 15000;
    this.isPaused = false;
    this.runnerFn = null; // injected to avoid circular dependency with document.service
  }

  /**
   * Inject the extraction runner function.
   * @param {Function} runner - runExtraction function
   */
  setRunner(runner) {
    this.runnerFn = runner;
  }

  /**
   * Enqueue a job for background processing.
   * @param {Object} jobPayload - { file, record, emitter, job }
   */
  enqueue(jobPayload) {
    this.inMemoryQueue.push(jobPayload);
    setImmediate(() => this._tick());
  }

  /**
   * Main scheduling loop. Dispatches work up to concurrency limit.
   */
  async _tick() {
    if (this.isPaused) return;

    while (this.activeWorkers < this.concurrency) {
      let nextJobPayload = null;

      // 1. Check in-memory queue first (freshly uploaded files with local disk handles)
      if (this.inMemoryQueue.length > 0) {
        nextJobPayload = this.inMemoryQueue.shift();
      } else {
        // 2. Poll next queued job from PostgreSQL (atomic claim via FOR UPDATE SKIP LOCKED)
        try {
          const claimedDbJob = await documentProcessingJobRepository.claimNextQueuedJob();
          if (claimedDbJob) {
            nextJobPayload = this._hydratePayloadFromDb(claimedDbJob);
          }
        } catch (dbErr) {
          // In test environments or during DB reconnects, avoid tight loop
          console.warn("[DocumentQueue] DB claim query failed:", dbErr.message);
          break;
        }
      }

      if (!nextJobPayload) {
        // No work currently available
        break;
      }

      this.activeWorkers++;
      this._processJob(nextJobPayload).finally(() => {
        this.activeWorkers--;
        setImmediate(() => this._tick());
      });
    }
  }

  /**
   * Executes a single document job with active 15s heartbeats.
   */
  async _processJob({ file, record, emitter, job }) {
    const jobId = record?.jobId || job?.id;
    let heartbeatTimer = null;

    if (jobId) {
      heartbeatTimer = setInterval(async () => {
        try {
          await documentProcessingJobRepository.updateHeartbeat(jobId);
        } catch (err) {
          console.warn(`[DocumentQueue] Failed to update heartbeat for job ${jobId}:`, err.message);
        }
      }, this.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    try {
      if (typeof this.runnerFn === "function") {
        await this.runnerFn({ file, record, emitter, job });
      } else {
        // Fallback dynamically require runExtraction
        const { runExtraction } = require("../document.service");
        await runExtraction({ file, record, emitter, job });
      }
    } catch (err) {
      console.error(
        `[DocumentQueue] Job execution failed for ${record?.fileKey || job?.fileKey}:`,
        err,
      );
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  }

  /**
   * Hydrates payload for orphaned or re-enqueued jobs claimed from PostgreSQL.
   */
  _hydratePayloadFromDb(jobRow) {
    const fileKey = jobRow.fileKey;
    const userId = jobRow.userId;
    const batchId = jobRow.metadata?.batchId || null;
    const originalName = jobRow.metadata?.originalName || "document";
    const mimeType = jobRow.metadata?.mimeType || "application/pdf";

    const emitter = ProgressEmitter.for({
      fileKey,
      fileName: originalName,
      batchId,
      patientId: userId,
    });

    const record = {
      jobId: jobRow.id,
      fileKey,
      batchId,
      patientId: userId,
      uploadedBy: userId,
      fileName: originalName,
      mimeType,
      sizeBytes: 0,
      status: StageType.IN_PROGRESS,
      stage: jobRow.stage || DOCUMENT_STAGES.OCR_RUNNING,
      attemptCount: jobRow.attemptCount || 1,
      bucket: jobRow.checkpointData?.s3Bucket || env.patientDocumentsBucket,
    };

    const file = {
      originalname: originalName,
      mimetype: mimeType,
      path: null,
      buffer: null,
    };

    return { file, record, emitter, job: jobRow };
  }

  /**
   * Resumes orphaned RUNNING jobs upon server boot.
   * Uploaded documents are re-enqueued to resume from their checkpointed stage.
   * Un-uploaded documents are marked FAILED with requiresReupload = true.
   */
  async resumeOrphanedJobsOnBoot() {
    try {
      const orphaned = await documentProcessingJobRepository.getOrphanedRunningJobs();
      if (!orphaned || orphaned.length === 0) return [];

      const recovered = [];
      for (const job of orphaned) {
        const isUploaded =
          job.checkpointData?.uploaded ||
          (job.completedStages && job.completedStages.includes(DOCUMENT_STAGES.UPLOADING));

        if (isUploaded) {
          // Document is safely in S3/GCP; can resume pipeline execution without local file
          await documentProcessingJobRepository.reEnqueueJob(job.id, {
            message: "Resuming execution from checkpoint after server restart",
          });
          recovered.push({ id: job.id, fileKey: job.fileKey, resumed: true });
          console.log(
            `[BootRecovery] Re-enqueued job ${job.fileKey} to resume from stage ${job.stage}`,
          );
        } else {
          // Local file was lost before storage persistence completed
          await documentProcessingJobRepository.checkpointStage(job.id, {
            status: "FAILED",
            stageStatus: StageType.FAILED,
            retryable: true,
            requiresReupload: true,
            error: "Server restarted before document upload completed; please retry with file.",
            lastHeartbeatAt: new Date(),
          });
          recovered.push({ id: job.id, fileKey: job.fileKey, resumed: false });
        }
      }

      // Trigger queue worker loop to immediately pick up re-enqueued jobs
      setImmediate(() => this._tick());
      return recovered;
    } catch (err) {
      console.warn("[BootRecovery] Error recovering orphaned jobs on boot:", err.message);
      return [];
    }
  }

  getStats() {
    return {
      activeWorkers: this.activeWorkers,
      inMemoryQueueLength: this.inMemoryQueue.length,
      concurrency: this.concurrency,
      isPaused: this.isPaused,
    };
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
    setImmediate(() => this._tick());
  }

  clear() {
    this.inMemoryQueue = [];
  }
}

module.exports = new DocumentQueueService();
module.exports.DocumentQueueService = DocumentQueueService;
