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
  }) {
    if (!fileKey) {
      throw new InvalidRequestException(errorConstants.FILE_KEY_IS_REQUIRED);
    }

    this.processName = processName;
    this.fileKey = fileKey;
    this.fileName = fileName;
    this.batchId = batchId;
    this.patientId = patientId;

    this.startedAt = Date.now();
    this._lastPercentage = 0;
    this._finished = false;
  }

  static for(ctx) {
    return new ProgressEmitter(ctx);
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
      timestamp: new Date(),
      elapsedMs: Date.now() - this.startedAt,
      ...extra,
    };
  }

  // Emits a stage event
  stage(stage, stageStatus = StageType.IN_PROGRESS, message = null, ratio = 0, extra = {}) {
    if (this._finished) {
      return;
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
  }

  // Emits page-level OCR progress inside the OCR percentage range.
  page(page, totalPages, extra = {}) {
    if (this._finished || !totalPages || page <= 0) {
      return;
    }
    const [from, to] = STAGE_WEIGHTS[DOCUMENT_STAGES.OCR_RUNNING];
    const ratio = Math.min(1, page / totalPages);
    const percentage = from + (to - from) * ratio;

    const event = this._base({
      stage: DOCUMENT_STAGES.OCR_RUNNING,
      stageStatus: StageType.IN_PROGRESS,
      percentage,
      status: ProcessStatus.SUCCESS,
      message: messageConstants.OCR_PAGE_OF_TOTAL_PAGE(page, totalPages),
      extra: {
        page,
        totalPages,
        ...extra,
      },
    });

    sseConnection.publish(this.fileKey, event);
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

    const event = this._base({
      stage,
      stageStatus: StageType.FAILED,
      percentage: this._lastPercentage,
      status: ProcessStatus.FAILED,
      message,
      extra,
    });

    sseConnection.fail(this.fileKey, error, event);
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
