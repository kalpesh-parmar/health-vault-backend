/**
 * In-process Server-Sent-Events bus for document extraction progress.
 *
 * Channel model
 * ─────────────
 *  • Document channel:  <fileKey>            — one per document (unchanged)
 *  • Batch channel:     batch:<batchId>      — fan-out of every document in a batch
 *
 * A batch channel carries ONE monotonic eventId sequence, which is what makes
 * `Last-Event-ID` reconnect replay correct for a multi-document stream.
 *
 * Lifecycle guarantees
 * ────────────────────
 *  • Late subscribers replay buffered events; reconnecting subscribers replay
 *    ONLY events newer than their lastEventId (no duplicates).
 *  • complete()/fail() publish a terminal event AND notify sinks to close.
 *  • Channels are swept when empty and past TTL; a hard cap prevents growth.
 *
 * ⚠️ CLUSTER MODE: this Map is per-process. Under PM2 cluster or multiple pods,
 * call setAdapter() with a Redis / PG LISTEN-NOTIFY bridge, otherwise events
 * published on worker A never reach a subscriber on worker B.
 */

const { randomUUID } = require("crypto");

const BUFFER_SIZE = 50; // Buffer size for each channel
const BATCH_BUFFER_SIZE = 250; // Buffer size for batch channels (5 docs x ~50 events)
const STREAM_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL for active streams
const TERMINAL_RETAIN_MS = 5 * 60 * 1000; // 5 minutes TTL for terminal (completed/failed) events
const MAX_CHANNELS = 2000; // Hard limit on the number of active channels

const TERMINAL_STAGES = new Set(["COMPLETED", "FAILED"]); // Terminal stages for SSE
const batchChannelKey = (batchId) => `batch:${batchId}`;

class OcrProgressBus {
  constructor() {
    /**
     * @type {Map<string, {
     *   subscribers: Map<string, { sink: Function, onTerminal?: Function }>,
     *   buffer: object[],
     *   nextEventId: number,
     *   expiresAt: number,
     *   terminal: boolean,
     *   isBatch: boolean,
     * }>}
     */
    this._channels = new Map();

    /** @type {Map<string, string>} fileKey -> batchId */
    this._fileKeyToBatch = new Map();

    /** @type {Map<string, { fileKeys: Set<string>, done: Set<string> }>} batchId -> progress */
    this._batches = new Map();

    /** Optional cross-process adapter: { publish(channelKey, event) } */
    this._adapter = null;

    this._sweep = setInterval(() => this._sweepChannels(), 60 * 1000);
    this._sweep.unref?.();
  }

  /* batch registration */

  /**
   * Associate documents with a batch. Call once at enqueue time, before the
   * pipeline starts publishing, so fan-out is available from the first event.
   */
  registerBatch(batchId, fileKeys = []) {
    if (!batchId) return;
    const entry = this._batches.get(batchId) ?? { fileKeys: new Set(), done: new Set() };
    for (const fk of fileKeys) {
      entry.fileKeys.add(fk);
      this._fileKeyToBatch.set(fk, batchId);
    }
    this._batches.set(batchId, entry);
    this._getOrCreate(batchChannelKey(batchId), true);
  }

  getBatchProgress(batchId) {
    const b = this._batches.get(batchId);
    if (!b) return null;
    return {
      batchId,
      total: b.fileKeys.size,
      completed: b.done.size,
      pending: [...b.fileKeys].filter((fk) => !b.done.has(fk)),
      isComplete: b.fileKeys.size > 0 && b.done.size === b.fileKeys.size,
    };
  }

  /* subscribe */

  /**
   * Subscribe to a document channel.
   * @param {string} channelKey  fileKey
   * @param {Function} sink      (event) => void
   * @param {{ sinceEventId?: number, onTerminal?: Function }} [opts]
   * @returns {() => void} unsubscribe — the caller MUST invoke this on disconnect
   */
  subscribe(channelKey, sink, opts = {}) {
    return this._attach(this._getOrCreate(channelKey, false), channelKey, sink, opts);
  }

  /**
   * Subscribe to every document in a batch through a single channel.
   * This is what a per-batch SSE connection uses.
   */
  subscribeBatch(batchId, sink, opts = {}) {
    const key = batchChannelKey(batchId);
    return this._attach(this._getOrCreate(key, true), key, sink, opts);
  }

  _attach(channel, channelKey, sink, { sinceEventId = null, onTerminal } = {}) {
    const subscriberId = randomUUID();
    channel.subscribers.set(subscriberId, { sink, onTerminal });
    channel.expiresAt = Math.max(channel.expiresAt, Date.now() + STREAM_TTL_MS);

    // Replay: only what the subscriber has not already seen.
    const since = Number.isFinite(Number(sinceEventId)) ? Number(sinceEventId) : -1;
    for (const event of channel.buffer) {
      if (event.eventId <= since) continue;
      try {
        sink(event);
      } catch {
        /* transport handles its own failures */
      }
    }

    // Already finished before this subscriber arrived — tell it to close.
    if (channel.terminal) {
      try {
        onTerminal?.();
      } catch {
        /* ignore */
      }
    }

    return () => {
      const ch = this._channels.get(channelKey);
      if (!ch) return;
      ch.subscribers.delete(subscriberId);
      if (ch.subscribers.size === 0 && ch.terminal) {
        ch.expiresAt = Math.min(ch.expiresAt, Date.now() + TERMINAL_RETAIN_MS);
      }
    };
  }

  /* publish */

  /**
   * Publish a document event. Automatically fans out to the batch channel
   * when the fileKey has been registered via registerBatch().
   */
  publish(channelKey, event, { fromAdapter = false } = {}) {
    const batchId = event.batchId ?? this._fileKeyToBatch.get(channelKey) ?? null;

    const enriched = this._emit(channelKey, false, {
      ...event,
      fileKey: event.fileKey || channelKey,
      batchId,
    });

    if (batchId) {
      this._emit(batchChannelKey(batchId), true, { ...enriched, eventId: undefined });
      if (TERMINAL_STAGES.has(enriched.stage)) {
        this._markDocumentDone(batchId, enriched.fileKey);
      }
    }

    if (this._adapter && !fromAdapter) {
      this._adapter.publish(channelKey, enriched);
    }
    return enriched;
  }

  /** Write one event into one channel. Never fans out — avoids recursion. */
  _emit(channelKey, isBatch, event) {
    const channel = this._getOrCreate(channelKey, isBatch);
    const enriched = {
      ...event,
      eventId: event.eventId ?? channel.nextEventId++,
      timestamp: event.timestamp || new Date().toISOString(),
    };
    if (event.eventId === undefined) {
      // id was stripped for the batch channel; take this channel's own sequence
      enriched.eventId = channel.nextEventId - 1;
    }

    const max = isBatch ? BATCH_BUFFER_SIZE : BUFFER_SIZE;
    channel.buffer.push(enriched);
    if (channel.buffer.length > max) {
      channel.buffer.splice(0, channel.buffer.length - max);
    }
    channel.expiresAt = Date.now() + STREAM_TTL_MS;

    for (const { sink } of channel.subscribers.values()) {
      try {
        sink(enriched);
      } catch {
        /* close handler evicts */
      }
    }
    return enriched;
  }

  /* terminal */

  /** Mark a document channel completed. */
  complete(channelKey, payload = {}) {
    this.publish(channelKey, {
      stage: "COMPLETED",
      percentage: 100,
      currentStep: "Done",
      ...payload,
    });
    this._closeChannel(channelKey);
  }

  /**
   * Mark a document channel failed.
   * The stack trace is deliberately NOT sent to clients — log it server-side.
   */
  fail(channelKey, error, payload = {}) {
    const message = typeof error === "string" ? error : error?.message || "Pipeline failed";

    this.publish(channelKey, {
      stage: "FAILED",
      percentage: 100,
      currentStep: "Failed",
      message,
      errorCode: payload.errorCode ?? "PIPELINE_FAILED",
      ...payload,
    });
    this._closeChannel(channelKey);
  }

  /** Terminal event for a whole batch; closes every subscriber on that channel. */
  completeBatch(batchId, payload = {}) {
    const key = batchChannelKey(batchId);
    this._emit(key, true, {
      stage: "BATCH_COMPLETED",
      type: "batch.completed",
      batchId,
      ...this.getBatchProgress(batchId),
      ...payload,
    });
    this._closeChannel(key);
    this._batches.delete(batchId);
  }

  _markDocumentDone(batchId, fileKey) {
    const b = this._batches.get(batchId);
    if (!b) return;
    b.done.add(fileKey);
    if (b.fileKeys.size > 0 && b.done.size === b.fileKeys.size) {
      this.completeBatch(batchId);
    }
  }

  /** Publish is done — notify sinks so the SSE transport can close the socket. */
  _closeChannel(channelKey) {
    const channel = this._channels.get(channelKey);
    if (!channel) return;
    channel.terminal = true;
    channel.expiresAt = Date.now() + TERMINAL_RETAIN_MS;

    for (const { onTerminal } of channel.subscribers.values()) {
      try {
        onTerminal?.();
      } catch {
        /* ignore */
      }
    }
    for (const fk of this._fileKeyToBatch.keys()) {
      if (fk === channelKey) this._fileKeyToBatch.delete(fk);
    }
  }

  /* infra */

  /** Cross-process bridge. adapter.publish(channelKey, event) mirrors outbound. */
  setAdapter(adapter) {
    this._adapter = adapter;
  }

  /** Inbound from Redis / PG NOTIFY — does not re-publish outbound. */
  receiveRemote(channelKey, event) {
    this.publish(channelKey, event, { fromAdapter: true });
  }

  isTerminal(channelKey) {
    return this._channels.get(channelKey)?.terminal ?? false;
  }

  getStats() {
    let subscribers = 0;
    for (const ch of this._channels.values()) subscribers += ch.subscribers.size;
    return {
      channels: this._channels.size,
      batches: this._batches.size,
      subscribers,
      adapterEnabled: !!this._adapter,
    };
  }

  _getOrCreate(channelKey, isBatch = false) {
    let channel = this._channels.get(channelKey);
    if (!channel) {
      if (this._channels.size >= MAX_CHANNELS) this._evictOldest();
      channel = {
        subscribers: new Map(),
        buffer: [],
        nextEventId: 1,
        expiresAt: Date.now() + STREAM_TTL_MS,
        terminal: false,
        isBatch,
      };
      this._channels.set(channelKey, channel);
    }
    return channel;
  }

  /** Cap breached: drop the oldest subscriber-less channel. */
  _evictOldest() {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, ch] of this._channels) {
      if (ch.subscribers.size === 0 && ch.expiresAt < oldestAt) {
        oldestAt = ch.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this._channels.delete(oldestKey);
  }

  _sweepChannels() {
    const now = Date.now();
    for (const [key, channel] of this._channels) {
      if (channel.subscribers.size === 0 && channel.expiresAt < now) {
        this._channels.delete(key);
      }
    }
    for (const [batchId, b] of this._batches) {
      if (!this._channels.has(batchChannelKey(batchId)) && b.done.size >= b.fileKeys.size) {
        this._batches.delete(batchId);
      }
    }
  }

  /** Test/shutdown helper. */
  destroy() {
    clearInterval(this._sweep);
    this._channels.clear();
    this._batches.clear();
    this._fileKeyToBatch.clear();
  }
}

module.exports = new OcrProgressBus();
