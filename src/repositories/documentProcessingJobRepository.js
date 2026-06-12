const { and, eq, lt } = require("drizzle-orm");

const { db } = require("../configs/db");
const { documentProcessingJob } = require("../models/documentProcessingJob");

const DEFAULT_TTL_HOURS = 24;

class DocumentProcessingJobRepository {
  /**
   * Idempotent upsert keyed by fileKey. If a previous job for this file
   * key terminated successfully, we still create a fresh QUEUED row so the
   * caller can re-run extraction with different settings.
   */
  async startJob({ fileKey, userId, ttlHours = DEFAULT_TTL_HOURS }) {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(documentProcessingJob)
        .where(eq(documentProcessingJob.fileKey, fileKey))
        .limit(1);

      const baseValues = {
        completedAt: null,
        completedSteps: 0,
        currentStep: "Queued",
        error: null,
        expiresAt,
        extractedStructuredData: null,
        graphs: [],
        message: null,
        metadata: {},
        pendingSteps: 0,
        percentage: 0,
        rawOcrData: null,
        stage: "OCR_QUEUED",
        startedAt: null,
        status: "QUEUED",
        updatedAt: new Date(),
        userId,
      };

      if (existing) {
        const [updated] = await tx
          .update(documentProcessingJob)
          .set(baseValues)
          .where(eq(documentProcessingJob.id, existing.id))
          .returning();
        return updated;
      }

      const [created] = await tx
        .insert(documentProcessingJob)
        .values({ ...baseValues, fileKey })
        .returning();
      return created;
    });
  }

  async markRunning(jobId, patch = {}) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({ startedAt: new Date(), status: "RUNNING", updatedAt: new Date(), ...patch })
      .where(eq(documentProcessingJob.id, jobId))
      .returning();
    return row || null;
  }

  async updateProgress(jobId, patch) {
    const [row] = await db
      .update(documentProcessingJob)
      .set({ ...patch, updatedAt: new Date() })
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

  async sweepExpired() {
    return db
      .delete(documentProcessingJob)
      .where(lt(documentProcessingJob.expiresAt, new Date()))
      .returning({ id: documentProcessingJob.id });
  }
}

module.exports = new DocumentProcessingJobRepository();
