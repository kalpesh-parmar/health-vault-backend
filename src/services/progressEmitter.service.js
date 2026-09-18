const { errorConstants } = require("../constants/errorConstants");
const { InvalidRequestException } = require("../exceptions/appError");
const sseConnection = require("./sseConnection.service");
const { DOCUMENT_STAGES, STAGE_WEIGHTS } = require("../constants/documentProgress.constants");
const { ProcessStatus, StageType } = require("../enums/stageStatus");
const { messageConstants } = require("../constants/messageConstants");

const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

class ProgressEmitter {
  constructor({
    processName = messageConstants.DOCUMENT_PROCESSING,
    fileKey,
    fileName = null,
    batchId = null,
    patientId = null,
    totalPages = null,
  }) {
    if (!fileKey) {
      throw new InvalidRequestException(errorConstants.FILE_KEY_IS_REQUIRED);
    }

    this.processName = processName;
    this.fileKey = fileKey;
    this.fileName = fileName;
    this.batchId = batchId;
    this.patientId = patientId;
    this.totalPages = totalPages;

    this.startedAt = Date.now();
    this._lastPercentage = 0;
    this._finished = false;
  }

  static for(ctx) {
    return new ProgressEmitter(ctx);
  }

  setTotalPages(totalPages) {
    if (Number.isFinite(totalPages) && totalPages > 0) {
      this.totalPages = totalPages;
    }
  }

  // Creates the common SSE event envelope
  _base({
    stage,
    stageStatus,
    percentage,
    status = ProcessStatus.SUCCESS,
    message = null,
    extra = {},
  }) {
    const pct = Math.max(this._lastPercentage, clamp(percentage));
    this._lastPercentage = pct;
    return {
      processName: this.processName,
      fileKey: this.fileKey,
      fileName: this.fileName,
      batchId: this.batchId,
      patientId: this.patientId,
      stage,
      stageStatus,
      progress: pct,
      percentage: pct,
      status,
      message,
      totalPages: this.totalPages || extra.totalPages || undefined,
      timestamp: new Date(),
      elapsedMs: Date.now() - this.startedAt,
      ...extra,
    };
  }

  // Emits a stage event
  stage(stage, stageStatus = StageType.IN_PROGRESS, message = null, ratio = 0, extra = {}) {
    if (this._finished) {
      return null;
    }

    const range = STAGE_WEIGHTS[stage];
    if (!range) {
      throw new InvalidRequestException(messageConstants.UNKNOWN_DOCUMENT_STAGE(stage));
    }

    const [from, to] = range;
    const safeRatio = Math.max(0, Math.min(1, ratio));
    const percentage = from + (to - from) * safeRatio;
    const event = this._base({
      stage,
      stageStatus,
      percentage,
      status: ProcessStatus.SUCCESS,
      message,
      extra,
    });
    sseConnection.publish(this.fileKey, event);
    return event;
  }

  // Continuous progressive progress formula (REQ-06):
  // progress = stageBaseline + (unitsDone / totalUnits) * stageWeight
  progressWithinStage(stage, unitsDone, totalUnits, message = null, extra = {}) {
    if (this._finished) {
      return null;
    }

    const range = STAGE_WEIGHTS[stage];
    if (!range) {
      throw new InvalidRequestException(messageConstants.UNKNOWN_DOCUMENT_STAGE(stage));
    }

    const resolvedTotal = totalUnits || this.totalPages || 1;
    const safeUnitsDone = Math.max(0, Math.min(resolvedTotal, unitsDone));
    const ratio = resolvedTotal > 0 ? safeUnitsDone / resolvedTotal : 0;

    const [from, to] = range;
    const percentage = from + (to - from) * ratio;

    const event = this._base({
      stage,
      stageStatus: StageType.IN_PROGRESS,
      percentage,
      status: ProcessStatus.SUCCESS,
      message,
      extra: {
        page: unitsDone,
        totalPages: resolvedTotal,
        ...extra,
      },
    });

    sseConnection.publish(this.fileKey, event);
    return event;
  }

  // Emits page-level progress inside the OCR percentage range (or any multi-page stage)
  page(page, totalPages, extra = {}) {
    if (this._finished || page <= 0) {
      return null;
    }

    const total = totalPages || this.totalPages || 1;
    if (totalPages && (!this.totalPages || this.totalPages !== totalPages)) {
      this.totalPages = totalPages;
    }

    const msg = extra?.message || messageConstants.OCR_PAGE_OF_TOTAL_PAGE(page, total);
    return this.progressWithinStage(DOCUMENT_STAGES.OCR_RUNNING, page, total, msg, extra);
  }

  // Marks the document process as successfully completed.
  done(message = messageConstants.DOCUMENT_PROCESSING_COMPLETED_SUCCESSFULLY, extra = {}) {
    if (this._finished) {
      return;
    }

    this._finished = true;

    const event = this._base({
      stage: StageType.COMPLETED,
      stageStatus: StageType.COMPLETED,
      percentage: 100,
      status: ProcessStatus.SUCCESS,
      message,
      extra,
    });
    sseConnection.complete(this.fileKey, event);
  }

  // Marks the document process as failed.
  error(stage, error, extra = {}) {
    if (this._finished) {
      return;
    }
    this._finished = true;

    const message =
      typeof error === "string"
        ? error
        : error?.message || messageConstants.DOCUMENT_PROCESSING_FAILED;

    const errorCode =
      extra.errorCode ||
      error?.errorCode ||
      (typeof error === "string" ? undefined : error?.code) ||
      "PIPELINE_FAILED";
    const retryable =
      extra.retryable !== undefined
        ? extra.retryable
        : error?.retryable !== undefined
          ? error.retryable
          : true;
    const requiresReupload = extra.requiresReupload !== undefined ? extra.requiresReupload : false;
    const failedStage = extra.failedStage || stage;
    const resumeStage = extra.resumeStage || stage;

    const event = this._base({
      stage,
      stageStatus: StageType.FAILED,
      percentage: this._lastPercentage,
      status: ProcessStatus.FAILED,
      message,
      errorCode,
      retryable,
      requiresReupload,
      failedStage,
      resumeStage,
      extra: {
        errorCode,
        retryable,
        requiresReupload,
        failedStage,
        resumeStage,
        ...extra,
      },
    });

    sseConnection.fail(this.fileKey, error, {
      ...event,
      errorCode,
      retryable,
      requiresReupload,
      failedStage,
      resumeStage,
      ...extra,
    });
  }

  // Marks the document process as cancelled.
  cancel(message = messageConstants.DOCUMENT_PROCESSING_CANCELLED, extra = {}) {
    if (this._finished) {
      return;
    }

    this._finished = true;
    const event = this._base({
      stage: DOCUMENT_STAGES.CANCELLED,
      stageStatus: StageType.CANCELLED,
      percentage: this._lastPercentage,
      status: ProcessStatus.FAILED,
      message,
      extra,
    });

    sseConnection.fail(this.fileKey, null, event);
  }
}

module.exports = {
  ProgressEmitter,
};
