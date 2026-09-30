const crypto = require("crypto");

/**
 * Computes a SHA-256 hash of a buffer or string.
 * @param {Buffer|string} bufferOrString
 * @returns {string} Hex-encoded SHA-256 hash
 */
function computeSha256(bufferOrString) {
  if (!bufferOrString) return "";
  return crypto.createHash("sha256").update(bufferOrString).digest("hex");
}

/**
 * In-memory LRU/TTL cache for document validation results.
 */
class ValidationCache {
  constructor({ maxEntries = 1000, ttlMs = 60 * 60 * 1000 } = {}) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Retrieves a cached validation result by hash if not expired.
   * @param {string} hash
   * @returns {object|null}
   */
  get(hash) {
    if (!hash || !this.cache.has(hash)) {
      return null;
    }

    const entry = this.cache.get(hash);
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(hash);
      return null;
    }

    // Refresh position for LRU
    this.cache.delete(hash);
    this.cache.set(hash, entry);
    return entry.data;
  }

  /**
   * Caches validation result for a hash with TTL.
   * @param {string} hash
   * @param {object} data
   */
  set(hash, data) {
    if (!hash || !data) return;

    if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(hash, {
      data,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Checks if hash exists in cache without refreshing LRU.
   * @param {string} hash
   * @returns {boolean}
   */
  has(hash) {
    return this.get(hash) !== null;
  }

  /**
   * Clears all cache entries.
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Returns current cache entry count.
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }
}

const validationCache = new ValidationCache();

module.exports = {
  ValidationCache,
  validationCache,
  computeSha256,
};
