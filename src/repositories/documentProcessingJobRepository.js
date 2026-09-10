const { and, eq, lt, ne, sql, or, isNull } = require("drizzle-orm");

const { db } = require("../configs/db");
const { documentProcessingJob } = require("../models/documentProcessingJob");

const DEFAULT_TTL_HOURS = 24;

class DocumentProcessingJobRepository {
  async createQueuedJob(
    { fileKey, userId, mimeType, originalName, ttlHours = DEFAULT_TTL_HOURS },
    tx = null,
  ) {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const client = tx || db;

    const baseValues = {
      completedAt: null,
      completedSteps: 0,
      currentStep: "Queued",
      error: null,
      expiresAt,
      extractedStructuredData: null,
      graphs: [],
      message: null,
      metadata: {
        ...(mimeType ? { mimeType } : {}),
        ...(originalName ? { originalName } : {}),
      },
      pendingSteps: 0,
      percentage: 0,
      rawOcrData: null,
      stage: "OCR_QUEUED",
      startedAt: null,
      status: "QUEUED",
      updatedAt: new Date(),
      userId,
    };

    const [existing] = await client
      .select()
      .from(documentProcessingJob)
      .where(eq(documentProcessingJob.fileKey, fileKey))
      .limit(1);

    if (existing) {
      const mergedMetadata = {
        ...(existing.metadata || {}),
        ...baseValues.metadata,
      };
      const [updated] = await client
        .update(documentProcessingJob)
        .set({
          ...baseValues,
          metadata: mergedMetadata,
        })
        .where(eq(documentProcessingJob.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await client
      .insert(documentProcessingJob)
      .values({ ...baseValues, fileKey })
      .returning();
    return created;
  }

  /**
   * Idempotent upsert keyed by fileKey. If a previous job for this file
   * key terminated successfully, we still create a fresh QUEUED row so the
   * caller can re-run extraction with different settings.
   */
  async startJob({ fileKey, userId, mimeType, ttlHours = DEFAULT_TTL_HOURS }) {
    return this.createQueuedJob({ fileKey, userId, mimeType, ttlHours });
  }

  async markRunning(jobId, patch = {}) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: "RUNNING",
        updatedAt: new Date(),
        ...patch,
      })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async updateProgress(jobId, patch) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        ...patch,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async markCompleted(jobId, patch) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        ...patch,
        completedAt: new Date(),
        percentage: 100,
        stage: "COMPLETED",
        status: "COMPLETED",
        updatedAt: new Date(),
      })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async markFailed(jobId, error) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        completedAt: new Date(),
        error: error?.message || String(error || "unknown error"),
        percentage: 100,
        stage: "FAILED",
        status: "FAILED",
        updatedAt: new Date(),
      })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async findByFileKey(fileKey, userId) {
    const [row] = await db
      .select()
      .from(documentProcessingJob)
      .where(
        and(eq(documentProcessingJob.fileKey, fileKey), eq(documentProcessingJob.userId, userId)),
      )
      .limit(1);
    return row || null;
  }

  async claimJobForRetry(fileKey, userId) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        status: "RUNNING",
        stageStatus: "IN_PROGRESS",
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        attemptCount: sql`${documentProcessingJob.attemptCount} + 1`,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingJob.fileKey, fileKey),
          eq(documentProcessingJob.userId, userId),
          ne(documentProcessingJob.status, "RUNNING"),
        ),
      )
      .returning();
    return row || null;
  }

  async checkpointStage(jobId, patch = {}) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        ...patch,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async findStalledRunningJobs(cutoffDate) {
    return db
      .select()
      .from(documentProcessingJob)
      .where(
        and(
          eq(documentProcessingJob.status, "RUNNING"),
          or(
            lt(documentProcessingJob.lastHeartbeatAt, cutoffDate),
            and(
              isNull(documentProcessingJob.lastHeartbeatAt),
              or(
                lt(documentProcessingJob.startedAt, cutoffDate),
                lt(documentProcessingJob.createdAt, cutoffDate),
              ),
            ),
          ),
        ),
      );
  }

  async failStalledRunningJobs(cutoffDate, reason = "Job execution timed out without heartbeat") {
    return db
      .update(documentProcessingJob)
      .set({
        status: "FAILED",
        stageStatus: "FAILED",
        retryable: true,
        error: reason,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingJob.status, "RUNNING"),
          or(
            lt(documentProcessingJob.lastHeartbeatAt, cutoffDate),
            and(
              isNull(documentProcessingJob.lastHeartbeatAt),
              or(
                lt(documentProcessingJob.startedAt, cutoffDate),
                lt(documentProcessingJob.createdAt, cutoffDate),
              ),
            ),
          ),
        ),
      )
      .returning();
  }

  async reconcileRunningJobsOnBoot() {
    return db
      .update(documentProcessingJob)
      .set({
        status: "FAILED",
        stageStatus: "FAILED",
        retryable: true,
        error: "Server restarted during document processing",
        requiresReupload: sql`CASE WHEN ${documentProcessingJob.stage} IN ('QUEUED', 'VALIDATING', 'UPLOADING') THEN true ELSE false END`,
        updatedAt: new Date(),
      })
      .where(eq(documentProcessingJob.status, "RUNNING"))
      .returning();
  }

  async sweepExpired() {
    return db
      .delete(documentProcessingJob)
      .where(lt(documentProcessingJob.expiresAt, new Date()))
      .returning({ id: documentProcessingJob.id });
  }

  async getUserJobSummary(userId) {
    if (!userId) {
      return { totalUploads: 0, completed: 0, failed: 0, rejected: 0, processing: 0 };
    }

    const rows = await db
      .select({
        status: documentProcessingJob.status,
        count: sql`count(*)`.mapWith(Number),
      })
      .from(documentProcessingJob)
      .where(eq(documentProcessingJob.userId, userId))
      .groupBy(documentProcessingJob.status);

    let completed = 0;
    let failed = 0;
    let rejected = 0;
    let processing = 0;
    let totalUploads = 0;

    for (const row of rows) {
      const st = String(row.status || "").toUpperCase();
      const cnt = Number(row.count || 0);
      totalUploads += cnt;
      if (st === "COMPLETED") {
        completed += cnt;
      } else if (st === "FAILED") {
        failed += cnt;
      } else if (st === "REJECTED") {
        rejected += cnt;
      } else {
        processing += cnt;
      }
    }

    return { totalUploads, completed, failed, rejected, processing };
  }

  async findUserJobDocumentNames(userId) {
    if (!userId) return [];
    const rows = await db
      .select({
        fileKey: documentProcessingJob.fileKey,
        metadata: documentProcessingJob.metadata,
      })
      .from(documentProcessingJob)
      .where(eq(documentProcessingJob.userId, userId))
      .orderBy(documentProcessingJob.createdAt);

    return rows.map((r) => r.metadata?.originalName || r.fileKey?.split("/").pop()).filter(Boolean);
  }
}

module.exports = new DocumentProcessingJobRepository();
