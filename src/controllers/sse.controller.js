const { StatusCodes } = require("http-status-codes");
const sseConnection = require("../services/sseConnection.service");
const sseTransport = require("../services/sseTransport.service");
const config = require("../configs/sse.config");
const { StageType, ProcessStatus } = require("../enums/stageStatus");
const { EventType } = require("../enums/eventType");
const { SseEmitterConstant } = require("../constants/sseEmitterConstant");
const { successResponse } = require("../helpers/generalResponse");
const { messageConstants } = require("../constants/messageConstants");

class SseController {
  streamFile = (req, res) => {
    const { fileKey } = req?.params || {};
    const authUserId = req?.auth?.userId;

    if (!fileKey) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        status: "FAILED",
        message: "fileKey is required",
      });
    }

    const channel = sseConnection.channels.get(fileKey);

    if (!channel) {
      return res.status(StatusCodes.NOT_FOUND).json({
        status: "FAILED",
        message: "Document not found or stream expired",
      });
    }

    // Verify document ownership before opening the SSE connection.
    if (channel.ownerId && authUserId && channel.ownerId !== authUserId) {
      return res.status(StatusCodes.FORBIDDEN).json({
        status: "FAILED",
        message: "Unauthorized access to document stream",
      });
    }

    const lastEventId = req.get("Last-Event-ID") || req.query.lastEventId || null;

    sseTransport.initialize(res);

    let closed = false;
    let unsubscribe = null;

    const cleanup = () => {
      if (closed) return;

      closed = true;

      unsubscribe?.();
      unsubscribe = null;

      clearInterval(heartbeat);
    };

    const heartbeat = setInterval(() => {
      if (!sseTransport.heartbeat(res)) {
        cleanup();
      }
    }, config.heartbeatMs);

    req.on?.("close", cleanup);
    res.on?.("error", cleanup);

    unsubscribe = sseConnection.subscribe(
      fileKey,
      (event) => {
        if (closed) return;

        if (!sseTransport.write(res, event)) {
          cleanup();
        }
      },
      {
        sinceEventId: lastEventId,

        onTerminal: () => {
          setImmediate(() => {
            if (closed) return;

            sseTransport.close(res);
            cleanup();
          });
        },
      },
    );

    // Send connection handshake.
    return sseTransport.write(res, {
      type: EventType.STREAM_CONNECTED,
      batchId: channel.batchId || null,
      fileKey,
      fileName: channel.fileName || null,
      stage: StageType.CONNECTED,
      stageStatus: StageType.CONNECTED,
      progress: 0,
      percentage: 0,
      status: ProcessStatus.SUCCESS,
      message: SseEmitterConstant.SSE_STREAM_CONNECTED,
    });
  };

  streamBatch = (req, res) => {
    const { batchId } = req.params;
    const lastEventId = req.get("Last-Event-ID") || req.query.lastEventId || null;

    sseTransport.initialize(res);

    let closed = false;
    let unsubscribe = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;

      unsubscribe?.();
      unsubscribe = null;

      clearInterval(heartbeat);
    };

    const heartbeat = setInterval(() => {
      if (!sseTransport.heartbeat(res)) cleanup();
    }, config.heartbeatMs);

    req.on?.("close", cleanup);
    res.on?.("error", cleanup);

    unsubscribe = sseConnection.subscribeBatch(
      batchId,
      (event) => {
        if (closed) return;
        if (!sseTransport.write(res, event)) cleanup();
      },
      {
        sinceEventId: lastEventId,
        onTerminal: () => {
          setImmediate(() => {
            if (!closed) {
              sseTransport.close(res);
              cleanup();
            }
          });
        },
      },
    );

    sseTransport.write(res, {
      type: EventType.STREAM_CONNECTED,
      stage: StageType.CONNECTED,
      stageStatus: StageType.CONNECTED,
      batchId,
      fileKey: null,
      fileName: null,
      progress: 0,
      percentage: 0,
      status: ProcessStatus.SUCCESS,
      message: SseEmitterConstant.BATCH_SSE_STREAM_CONNECTED,
    });
  };

  stats = (_req, res) => {
    successResponse(res, sseConnection.getStats(), messageConstants.SSE_STATS_FETCHED);
  };
}

module.exports = new SseController();
