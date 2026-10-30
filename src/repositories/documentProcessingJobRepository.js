const { and, eq, lt, ne, sql, or, isNull } = require("drizzle-orm");

const { db } = require("../configs/db");
const { env } = require("../configs/env");
const { documentProcessingJob } = require("../models/documentProcessingJob");
const { document } = require("../models/document");

const DEFAULT_TTL_HOURS = 24;

class DocumentProcessingJobRepository {
  async createQueuedJob(
    {
      fileKey,
      userId,
      mimeType,
      originalName,
      pageCount = 1,
      metadata = {},
      checkpointData = {},
      ttlHours = DEFAULT_TTL_HOURS,
    },
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
        pageCount: Number(pageCount) || 1,
        ...metadata,
      },
      checkpointData: {
        pageCount: Number(pageCount) || 1,
        ...checkpointData,
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
      const mergedCheckpointData = {
        ...(existing.checkpointData || {}),
        ...baseValues.checkpointData,
      };
      const [updated] = await client
        .update(documentProcessingJob)
        .set({
          ...baseValues,
          metadata: mergedMetadata,
          checkpointData: mergedCheckpointData,
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
  async startJob({
    fileKey,
    userId,
    mimeType,
    originalName,
    pageCount = 1,
    metadata = {},
    checkpointData = {},
    ttlHours = DEFAULT_TTL_HOURS,
  }) {
    return this.createQueuedJob({
      fileKey,
      userId,
      mimeType,
      originalName,
      pageCount,
      metadata,
      checkpointData,
      ttlHours,
    });
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
    if (!fileKey || !userId) return null;
    const cleanKey = String(fileKey).trim().replace(/['"]+/g, "");
    if (!cleanKey) return null;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanKey);

    const conditions = [
      eq(documentProcessingJob.fileKey, cleanKey),
      sql`${documentProcessingJob.metadata}->>'s3Key' = ${cleanKey}`,
      sql`${documentProcessingJob.metadata}->>'key' = ${cleanKey}`,
      sql`${documentProcessingJob.metadata}->>'documentId' = ${cleanKey}`,
      sql`${documentProcessingJob.checkpointData}->>'s3Key' = ${cleanKey}`,
      sql`${documentProcessingJob.checkpointData}->>'documentId' = ${cleanKey}`,
    ];

    if (isUuid) {
      conditions.push(eq(documentProcessingJob.id, cleanKey));
    }

    const [row] = await db
      .select()
      .from(documentProcessingJob)
      .where(and(eq(documentProcessingJob.userId, userId), or(...conditions)))
      .orderBy(sql`${documentProcessingJob.createdAt} DESC`)
      .limit(1);

    if (row) return row;

    // Fallback: Check if cleanKey matches an existing document row (by id or s3Key)
    try {
      const docConditions = [eq(document.userId, userId)];
      if (isUuid) {
        docConditions.push(or(eq(document.id, cleanKey), eq(document.s3Key, cleanKey)));
      } else {
        docConditions.push(eq(document.s3Key, cleanKey));
      }

      const [foundDoc] = await db
        .select({ id: document.id, s3Key: document.s3Key })
        .from(document)
        .where(and(...docConditions))
        .limit(1);

      if (foundDoc) {
        const docMatches = [
          eq(documentProcessingJob.fileKey, foundDoc.s3Key),
          sql`${documentProcessingJob.metadata}->>'s3Key' = ${foundDoc.s3Key}`,
          sql`${documentProcessingJob.metadata}->>'key' = ${foundDoc.s3Key}`,
          sql`${documentProcessingJob.metadata}->>'documentId' = ${foundDoc.id}`,
          sql`${documentProcessingJob.checkpointData}->>'s3Key' = ${foundDoc.s3Key}`,
          sql`${documentProcessingJob.checkpointData}->>'documentId' = ${foundDoc.id}`,
        ];
        const [fallbackRow] = await db
          .select()
          .from(documentProcessingJob)
          .where(and(eq(documentProcessingJob.userId, userId), or(...docMatches)))
          .orderBy(sql`${documentProcessingJob.createdAt} DESC`)
          .limit(1);

        if (fallbackRow) return fallbackRow;
      }
    } catch {
      // Ignore fallback lookup errors
    }

    return null;
  }

  async findActiveJobBySha256(userId, sha256, maxAgeMinutes = 60) {
    if (!userId || !sha256) return null;
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    const [row] = await db
      .select()
      .from(documentProcessingJob)
      .where(
        and(
          eq(documentProcessingJob.userId, userId),
          sql`${documentProcessingJob.metadata}->>'sha256' = ${sha256}`,
          sql`${documentProcessingJob.createdAt} >= ${cutoff}`,
          or(
            eq(documentProcessingJob.status, "QUEUED"),
            eq(documentProcessingJob.status, "RUNNING"),
            eq(documentProcessingJob.status, "COMPLETED"),
            eq(documentProcessingJob.status, "PARTIAL"),
          ),
        ),
      )
      .orderBy(sql`${documentProcessingJob.createdAt} DESC`)
      .limit(1);
    return row || null;
  }

  async claimJobForRetry(fileKey, userId) {
    if (!fileKey || !userId) return null;
    const cleanKey = String(fileKey).trim().replace(/['"]+/g, "");
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanKey);

    const matchConditions = [
      eq(documentProcessingJob.fileKey, cleanKey),
      sql`${documentProcessingJob.metadata}->>'s3Key' = ${cleanKey}`,
      sql`${documentProcessingJob.checkpointData}->>'s3Key' = ${cleanKey}`,
    ];
    if (isUuid) {
      matchConditions.push(eq(documentProcessingJob.id, cleanKey));
    }

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
          eq(documentProcessingJob.userId, userId),
          or(...matchConditions),
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

  async claimNextQueuedJob() {
    const isPythonMode = Boolean(env.usePythonPipeline);
    const result = await db.execute(sql`
      UPDATE document_processing_jobs
      SET status = 'RUNNING',
          stage_status = 'IN_PROGRESS',
          started_at = NOW(),
          last_heartbeat_at = NOW(),
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      WHERE id = (
        SELECT id FROM document_processing_jobs
        WHERE status = 'QUEUED'
          AND (
            metadata->>'processor' = 'node'
            OR (metadata->>'processor' IS NULL AND NOT ${isPythonMode})
          )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *;
    `);
    return result.rows?.[0] || null;
  }

  async updateHeartbeat(jobId) {
    if (!jobId) return null;
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async getOrphanedRunningJobs() {
    return db
      .select()
      .from(documentProcessingJob)
      .where(eq(documentProcessingJob.status, "RUNNING"));
  }

  async reEnqueueJob(jobId, patch = {}) {
    if (!jobId) return null;
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        status: "QUEUED",
        stageStatus: "QUEUED",
        error: null,
        updatedAt: new Date(),
        ...patch,
      })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async claimJobForRetryReEnqueue(jobId, patch = {}) {
    if (!jobId) return null;
    const [row] = await db
      .update(documentProcessingJob)
      .set({
        status: "QUEUED",
        stageStatus: "QUEUED",
        error: null,
        updatedAt: new Date(),
        ...patch,
      })
      .where(
        and(
          eq(documentProcessingJob.id, jobId),
          ne(documentProcessingJob.status, "RUNNING"),
          ne(documentProcessingJob.status, "QUEUED"),
        ),
      )
      .returning();
    return row || null;
  }
}

module.exports = new DocumentProcessingJobRepository();
