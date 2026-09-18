const crypto = require("crypto");

/**
 * High-Speed In-Memory LRU Cache for Page OCR Results
 * Keyed by SHA-256 content hash of image buffer or base64 string.
 * Prevents redundant inference on identical pages, retries, and batch re-runs.
 * Zero background timers to guarantee zero Jest open handles.
 */
class OcrPageCache {
  constructor(maxSize = 500, ttlMs = 24 * 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  hashPageContent(content) {
    if (!content) return null;
    const hash = crypto.createHash("sha256");
    if (Buffer.isBuffer(content)) {
      hash.update(content);
    } else if (typeof content === "string") {
      hash.update(content, "utf8");
    } else {
      hash.update(JSON.stringify(content));
    }
    return hash.digest("hex");
  }

  getPageOcr(pageHash) {
    if (!pageHash || !this.cache.has(pageHash)) {
      this.misses++;
      return null;
    }

    const entry = this.cache.get(pageHash);
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(pageHash);
      this.misses++;
      return null;
    }

    // Refresh LRU order
    this.cache.delete(pageHash);
    this.cache.set(pageHash, entry);
    this.hits++;
    return entry.value;
  }

  setPageOcr(pageHash, result) {
    if (!pageHash || !result) return;

    if (this.cache.has(pageHash)) {
      this.cache.delete(pageHash);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest item
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(pageHash, {
      value: result,
      timestamp: Date.now(),
    });
  }

  clearOcrCache() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

const ocrPageCache = new OcrPageCache();

module.exports = {
  ocrPageCache,
  OcrPageCache,
};
