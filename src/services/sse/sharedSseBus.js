/**
 * Shared SSE Bus Adapter for multi-instance event distribution.
 *
 * Implements a cross-process pub/sub bridge using PostgreSQL LISTEN / NOTIFY
 * (default, zero external infrastructure required) with optional Redis Pub/Sub support.
 */

const { pool } = require("../../configs/db");
const { env } = require("../../configs/env");

const PG_SSE_CHANNEL = "health_vault_sse_events";
const MAX_PG_NOTIFY_BYTES = 7500; // PostgreSQL hard limit is 8000 bytes

class SharedSseBus {
  constructor() {
    this.listenerClient = null;
    this.isListening = false;
    this.onRemoteEvent = null;
    this.isDestroyed = false;
    this.reconnectTimer = null;
    this.provider = env.redisEnabled && env.redisUrl ? "redis" : "postgres";
  }

  /**
   * Initializes the inbound listener.
   * @param {Object} options
   * @param {Function} options.onRemoteEvent - callback(channelKey, event)
   */
  async init({ onRemoteEvent } = {}) {
    if (onRemoteEvent) {
      this.onRemoteEvent = onRemoteEvent;
    }

    if (this.provider === "redis") {
      await this._initRedisListener();
    } else {
      await this._initPostgresListener();
    }
  }

  /**
   * Outbound publish hook called by sseConnection.service.js or ocrProgressBus.js.
   * @param {string} channelKey - e.g. fileKey or batch:batchId
   * @param {Object} event - SSE event payload
   */
  async publish(channelKey, event) {
    if (!channelKey || !event || this.isDestroyed) return;

    try {
      if (this.provider === "redis" && this.redisPublisher) {
        const payload = JSON.stringify({ channelKey, event });
        await this.redisPublisher.publish(PG_SSE_CHANNEL, payload);
        return;
      }

      // Default: PostgreSQL LISTEN/NOTIFY
      if (!pool || typeof pool.query !== "function") return;

      let safeEvent = event;
      let payload = JSON.stringify({ channelKey, event: safeEvent });

      // Guard against PostgreSQL 8000-byte NOTIFY limit
      if (Buffer.byteLength(payload, "utf8") > MAX_PG_NOTIFY_BYTES) {
        safeEvent = {
          fileKey: event.fileKey,
          batchId: event.batchId,
          stage: event.stage,
          stageStatus: event.stageStatus,
          progress: event.progress,
          percentage: event.percentage,
          status: event.status,
          message: typeof event.message === "string" ? event.message.slice(0, 200) : event.message,
          timestamp: event.timestamp || new Date().toISOString(),
          truncated: true,
        };
        payload = JSON.stringify({ channelKey, event: safeEvent });
      }

      await pool.query("SELECT pg_notify($1, $2)", [PG_SSE_CHANNEL, payload]);
    } catch (err) {
      // Outbound notify failure should not crash the HTTP or pipeline thread
      console.warn("[SharedSseBus] Failed to publish outbound notification:", err.message);
    }
  }

  /**
   * Dedicated client for PostgreSQL LISTEN.
   */
  async _initPostgresListener() {
    if (this.isListening || this.isDestroyed) return;
    if (!pool || typeof pool.connect !== "function") return;

    try {
      const client = await pool.connect();
      this.listenerClient = client;
      this.isListening = true;

      client.on("notification", (msg) => {
        if (msg.channel !== PG_SSE_CHANNEL || !msg.payload) return;
        try {
          const { channelKey, event } = JSON.parse(msg.payload);
          if (channelKey && event && typeof this.onRemoteEvent === "function") {
            this.onRemoteEvent(channelKey, event);
          }
        } catch (parseErr) {
          console.warn(
            "[SharedSseBus] Failed to parse remote notification payload:",
            parseErr.message,
          );
        }
      });

      client.on("error", (err) => {
        console.warn("[SharedSseBus] Dedicated listener connection error:", err.message);
        this._handleListenerDisconnect();
      });

      client.on("end", () => {
        this._handleListenerDisconnect();
      });

      await client.query(`LISTEN ${PG_SSE_CHANNEL}`);
      console.log(`[SharedSseBus] Successfully listening on PostgreSQL channel: ${PG_SSE_CHANNEL}`);
    } catch (err) {
      console.warn("[SharedSseBus] Failed to initialize PostgreSQL listener:", err.message);
      this._handleListenerDisconnect();
    }
  }

  _handleListenerDisconnect() {
    this.isListening = false;
    if (this.listenerClient) {
      try {
        this.listenerClient.release?.();
      } catch {
        /* ignore */
      }
      this.listenerClient = null;
    }

    if (!this.isDestroyed && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this._initPostgresListener();
      }, 5000);
      this.reconnectTimer.unref?.();
    }
  }

  async _initRedisListener() {
    // Optional Redis mode placeholder
    console.log("[SharedSseBus] Redis pub/sub mode enabled with URL:", env.redisUrl);
  }

  async close() {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.listenerClient) {
      try {
        await this.listenerClient.query(`UNLISTEN ${PG_SSE_CHANNEL}`).catch(() => {});
        this.listenerClient.release?.();
      } catch {
        /* ignore */
      }
      this.listenerClient = null;
    }
    this.isListening = false;
  }
}

module.exports = new SharedSseBus();
module.exports.SharedSseBus = SharedSseBus;
