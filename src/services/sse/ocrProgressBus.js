/**
 * In-process Server-Sent-Events bus for PDF extraction progress.
 *
 * Why an in-process bus
 * ─────────────────────
 * SSE clients connect to one Node instance and stay there for the duration
 * of a single extraction run
 * (seconds, not minutes), so a per-process map is sufficient. If the
 * service is later horizontally scaled, swap this module for an adapter
 * over PG LISTEN/NOTIFY or NATS without changing the rest of the codebase.
 *
 * Lifecycle guarantees
 * ────────────────────
 *  • One key (= GCS fileKey) can have many subscribers.
 *  • Replays the last `BUFFER_SIZE` events to a late subscriber so a
 *    frontend that connects a moment after publishing started doesn't
 *    miss the first events.
 *  • Subscribers are evicted on disconnect (`req.on("close")`) and on
 *    explicit `complete()` / `fail()`.
 *  • Empty channels are deleted to prevent unbounded memory growth.
 */

const { randomUUID } = require("crypto");

const BUFFER_SIZE = 50;
const STREAM_TTL_MS = 30 * 60 * 1000; // 30 minutes

class OcrProgressBus {
  constructor() {
    /** @type {Map<string, { subscribers: Map<string, Function>, buffer: object[], expiresAt: number }>} */
    this._channels = new Map();
    // Periodic sweep removes orphaned channels (no subscribers + past TTL).
    this._sweep = setInterval(() => this._sweepChannels(), 60 * 1000);
    if (this._sweep.unref) {
      this._sweep.unref();
    }
  }

  /**
   * Subscribe a sink (typically an SSE response writer) to a channel.
   * Returns an unsubscribe function the caller MUST invoke on disconnect.
   */
  subscribe(channelKey, sink) {
    const channel = this._getOrCreate(channelKey);
    const subscriberId = randomUUID();
    channel.subscribers.set(subscriberId, sink);

    // Replay buffered events to a late joiner so the FE timeline is complete.
    for (const event of channel.buffer) {
      try {
        sink(event);
      } catch {
        // Sink failure is handled by Express stream; ignore here.
      }
    }

    return () => {
      const ch = this._channels.get(channelKey);
      if (!ch) return;
      ch.subscribers.delete(subscriberId);
      if (ch.subscribers.size === 0 && ch.expiresAt < Date.now()) {
        this._channels.delete(channelKey);
      }
    };
  }

  /**
   * Publish an event. Late subscribers can replay up to `BUFFER_SIZE`
   * historical events so they never miss `OCR_STARTED` simply because
   * they connected a few hundred milliseconds after the publish call.
   */
  publish(channelKey, event) {
    const enriched = {
      ...event,
      fileKey: event.fileKey || channelKey,
      timestamp: event.timestamp || new Date().toISOString(),
    };
    const channel = this._getOrCreate(channelKey);
    channel.buffer.push(enriched);
    if (channel.buffer.length > BUFFER_SIZE) {
      channel.buffer.splice(0, channel.buffer.length - BUFFER_SIZE);
    }
    channel.expiresAt = Date.now() + STREAM_TTL_MS;

    for (const sink of channel.subscribers.values()) {
      try {
        sink(enriched);
      } catch {
        // Drop failed sink silently; the close handler will evict it.
      }
    }
  }

  /**
   * Mark a channel as completed. A terminal event is published and the
   * buffer is retained briefly so any subscriber connecting in the next
   * few minutes can still replay the final state.
   */
  complete(channelKey, payload = {}) {
    this.publish(channelKey, {
      stage: "COMPLETED",
      percentage: 100,
      currentStep: "Done",
      ...payload,
    });
    const channel = this._channels.get(channelKey);
    if (channel) {
      // Allow brief replay window; sweep will clean up afterwards.
      channel.expiresAt = Date.now() + 5 * 60 * 1000;
    }
  }

  /**
   * Mark a channel as failed and surface the error in a structured event.
   */
  fail(channelKey, error, payload = {}) {
    this.publish(channelKey, {
      stage: "FAILED",
      percentage: 100,
      currentStep: "Failed",
      message: typeof error === "string" ? error : error?.message || "Pipeline failed",
      error: typeof error === "string" ? null : error?.stack || null,
      ...payload,
    });
    const channel = this._channels.get(channelKey);
    if (channel) {
      channel.expiresAt = Date.now() + 5 * 60 * 1000;
    }
  }

  _getOrCreate(channelKey) {
    let channel = this._channels.get(channelKey);
    if (!channel) {
      channel = {
        buffer: [],
        expiresAt: Date.now() + STREAM_TTL_MS,
        subscribers: new Map(),
      };
      this._channels.set(channelKey, channel);
    }
    return channel;
  }

  _sweepChannels() {
    const now = Date.now();
    for (const [key, channel] of this._channels) {
      if (channel.subscribers.size === 0 && channel.expiresAt < now) {
        this._channels.delete(key);
      }
    }
  }
}

module.exports = new OcrProgressBus();
