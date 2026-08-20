const { randomUUID } = require("crypto");
const config = require("../configs/sse.config");
const { StageType } = require("../enums/stageStatus");
const { errorConstants } = require("../constants/errorConstants");

const TERMINAL_STAGES = new Set(["COMPLETED", "FAILED"]);
const batchChannelKey = (batchId) => `batch:${batchId}`;

class SseConnectionService {
  constructor() {
    this.channels = new Map();
    this.fileKeyToBatch = new Map();
    this.batches = new Map();
    this.adapter = null;

    this.sweepTimer = setInterval(() => this.sweepChannels(), 60 * 1000);
    this.sweepTimer.unref?.();
  }

  registerBatch(batchId, fileKeys = []) {
    if (!batchId) throw new Error("batchId is required");

    const batch = this.batches.get(batchId) || { fileKeys: new Set(), done: new Set() };

    for (const fileKey of fileKeys) {
      if (!fileKey) continue;
      batch.fileKeys.add(fileKey);
      this.fileKeyToBatch.set(fileKey, batchId);
      this.getOrCreate(batchChannelKey(batchId), true);
    }

    this.batches.set(batchId, batch);
    return this.getBatchProgress(batchId);
  }

  getBatchProgress(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return null;

    const pending = [...batch.fileKeys].filter((fileKey) => !batch.done.has(fileKey));

    return {
      batchId,
      total: batch.fileKeys.size,
      completed: batch.done.size,
      failed: 0,
      pending,
      isComplete: batch.fileKeys.size > 0 && batch.done.size === batch.fileKeys.size,
    };
  }

  subscribe(channelKey, sink, options = {}) {
    return this.attach(this.getOrCreate(channelKey, false), channelKey, sink, options);
  }

  subscribeBatch(batchId, sink, options = {}) {
    const key = batchChannelKey(batchId);
    return this.attach(this.getOrCreate(key, true), key, sink, options);
  }

  attach(channel, channelKey, sink, { sinceEventId = null, onTerminal } = {}) {
    const subscriberId = randomUUID();

    channel.subscribers.set(subscriberId, { sink, onTerminal });
    channel.expiresAt = Date.now() + config.streamTtlMs;

    const since = Number.isFinite(Number(sinceEventId)) ? Number(sinceEventId) : -1;

    // Replay only events newer than Last-Event-ID.
    for (const event of channel.buffer) {
      if (event.eventId <= since) continue;
      try {
        sink(event);
      } catch {
        // Transport owns socket errors.
      }
    }

    if (channel.terminal) {
      try {
        onTerminal?.();
      } catch {
        // Ignore terminal callback errors during SSE cleanup.
      }
    }

    return () => {
      const current = this.channels.get(channelKey);
      if (!current) return;

      current.subscribers.delete(subscriberId);

      if (current.subscribers.size === 0 && current.terminal) {
        current.expiresAt = Math.min(current.expiresAt, Date.now() + config.terminalRetainMs);
      }
    };
  }

  publish(channelKey, event, { fromAdapter = false } = {}) {
    const batchId = event.batchId || this.fileKeyToBatch.get(channelKey) || null;

    const documentEvent = this.emit(channelKey, false, {
      ...event,
      fileKey: event.fileKey || channelKey,
      batchId,
    });

    if (batchId) {
      // Batch has its own eventId sequence.
      this.emit(batchChannelKey(batchId), true, {
        ...documentEvent,
        eventId: undefined,
      });

      const isTerminal =
        TERMINAL_STAGES.has(documentEvent.stage) ||
        TERMINAL_STAGES.has(documentEvent.stageStatus) ||
        documentEvent.type === "document.completed" ||
        documentEvent.type === "document.failed";

      if (isTerminal) {
        this.markDocumentDone(batchId, documentEvent.fileKey);
      }
    }

    if (this.adapter && !fromAdapter) {
      this.adapter.publish(channelKey, documentEvent);
    }

    return documentEvent;
  }

  emit(channelKey, isBatch, event) {
    const channel = this.getOrCreate(channelKey, isBatch);

    const enriched = {
      ...event,
      eventId: channel.nextEventId++,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    const max = isBatch ? config.batchBufferSize : config.documentBufferSize;

    channel.buffer.push(enriched);

    if (channel.buffer.length > max) {
      channel.buffer.splice(0, channel.buffer.length - max);
    }

    channel.expiresAt = Date.now() + config.streamTtlMs;

    for (const subscriber of channel.subscribers.values()) {
      try {
        subscriber.sink(enriched);
      } catch {
        // Socket close/error is handled by controller.
      }
    }

    return enriched;
  }

  complete(channelKey, payload = {}) {
    const pct = payload.percentage ?? payload.progress ?? 100;
    const event = this.publish(channelKey, {
      type: "document.completed",
      stage: StageType.COMPLETED,
      stageStatus: StageType.COMPLETED,
      progress: pct,
      percentage: pct,
      ...payload,
    });

    this.closeChannel(channelKey);
    return event;
  }

  fail(channelKey, error, payload = {}) {
    const message =
      typeof error === "string" ? error : error?.message || "Document extraction failed";

    const pct = payload.percentage ?? payload.progress ?? 100;
    const event = this.publish(channelKey, {
      type: "document.failed",
      stage: payload.stage || StageType.FAILED,
      stageStatus: StageType.FAILED,
      progress: pct,
      percentage: pct,
      message,
      errorCode: payload.errorCode || "PIPELINE_FAILED",
      ...payload,
    });

    this.closeChannel(channelKey);
    return event;
  }

  completeBatch(batchId, payload = {}) {
    const key = batchChannelKey(batchId);
    const progress = this.getBatchProgress(batchId);

    const event = this.emit(key, true, {
      type: "batch.completed",
      stage: StageType.COMPLETED,
      batchId,
      ...progress,
      ...payload,
    });

    this.closeChannel(key);

    // Keep fileKey mappings until terminal retention has elapsed. This makes
    // late terminal events/reconnects safer; cleanup happens in sweepChannels.
    const batch = this.batches.get(batchId);
    if (batch) batch.terminalAt = Date.now();

    return event;
  }

  markDocumentDone(batchId, fileKey) {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    batch.done.add(fileKey);

    if (batch.fileKeys.size > 0 && batch.done.size === batch.fileKeys.size && !batch.completed) {
      batch.completed = true;
      this.completeBatch(batchId);
    }
  }

  closeChannel(channelKey) {
    const channel = this.channels.get(channelKey);
    if (!channel) return;

    channel.terminal = true;
    channel.expiresAt = Date.now() + config.terminalRetainMs;

    for (const subscriber of channel.subscribers.values()) {
      try {
        subscriber.onTerminal?.();
      } catch {
        // Ignore terminal callback errors during SSE cleanup.
      }
    }
  }

  setAdapter(adapter) {
    if (adapter && typeof adapter.publish !== "function") {
      throw new TypeError("SSE adapter must expose publish(channelKey, event)");
    }
    this.adapter = adapter;
  }

  receiveRemote(channelKey, event) {
    return this.publish(channelKey, event, { fromAdapter: true });
  }

  isTerminal(channelKey) {
    return this.channels.get(channelKey)?.terminal || false;
  }

  getStats() {
    let subscribers = 0;

    for (const channel of this.channels.values()) {
      subscribers += channel.subscribers.size;
    }
    return {
      channels: this.channels.size,
      batches: this.batches.size,
      subscribers,
      adapterEnabled: Boolean(this.adapter),
    };
  }

  getOrCreate(channelKey, isBatch = false) {
    if (!channelKey) throw new Error(errorConstants.CHANNEL_KEY_IS_REQUIRED);

    let channel = this.channels.get(channelKey);
    if (!channel) {
      if (this.channels.size >= config.maxChannels) {
        this.evictOldest();
      }

      channel = {
        subscribers: new Map(),
        buffer: [],
        nextEventId: 1,
        expiresAt: Date.now() + config.streamTtlMs,
        terminal: false,
        isBatch,
      };

      this.channels.set(channelKey, channel);
    }

    return channel;
  }

  evictOldest() {
    let oldestKey = null;
    let oldestExpiresAt = Infinity;

    for (const [key, channel] of this.channels) {
      if (channel.subscribers.size === 0 && channel.expiresAt < oldestExpiresAt) {
        oldestExpiresAt = channel.expiresAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.channels.delete(oldestKey);
    }
  }

  sweepChannels() {
    const now = Date.now();

    for (const [key, channel] of this.channels) {
      if (channel.subscribers.size === 0 && channel.expiresAt < now) {
        this.channels.delete(key);
      }
    }

    for (const [batchId, batch] of this.batches) {
      const channel = this.channels.get(batchChannelKey(batchId));

      if (
        batch.terminalAt &&
        now > batch.terminalAt + config.terminalRetainMs &&
        (!channel || channel.subscribers.size === 0)
      ) {
        this.batches.delete(batchId);

        for (const fileKey of batch.fileKeys) {
          if (this.fileKeyToBatch.get(fileKey) === batchId) {
            this.fileKeyToBatch.delete(fileKey);
          }
        }
      }
    }
  }

  destroy() {
    clearInterval(this.sweepTimer);
    this.channels.clear();
    this.batches.clear();
    this.fileKeyToBatch.clear();
  }
}

module.exports = new SseConnectionService();
