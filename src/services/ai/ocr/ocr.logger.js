const { randomUUID } = require("crypto");

/**
 * Minimal structured logger + retry helper for the OCR pipeline.
 *
 * Logs single-line JSON so they parse cleanly in any log aggregator, and
 * carries a `traceId` so every line of one OCR request can be correlated.
 */

function createTrace(seed) {
  return seed || `ocr_${randomUUID()}`;
}

function log(level, traceId, event, fields = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    traceId,
    event,
    ...redact(fields),
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Never log raw document bytes, base64 payloads, or API keys.
const REDACT_KEYS = new Set(["buffer", "base64", "imageB64", "apiKey", "authorization"]);
function redact(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT_KEYS.has(key)) {
      out[key] = "[redacted]";
    } else if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 500)}…[+${value.length - 500} chars]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

const ocrLogger = {
  info: (traceId, event, fields) => log("info", traceId, event, fields),
  warn: (traceId, event, fields) => log("warn", traceId, event, fields),
  error: (traceId, event, fields) => log("error", traceId, event, fields),
};

/**
 * Retry an async operation with exponential backoff + jitter.
 *
 * @param {() => Promise<T>} fn
 * @param {object} opts
 * @param {number} opts.retries        max additional attempts after the first
 * @param {number} opts.baseDelayMs
 * @param {number} opts.maxDelayMs
 * @param {(err:Error)=>boolean} opts.shouldRetry
 * @param {(info:{attempt:number,delayMs:number,error:Error})=>void} [opts.onRetry]
 */
async function withRetry(
  fn,
  { retries = 2, baseDelayMs = 500, maxDelayMs = 8000, shouldRetry = () => true, onRetry } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) break;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.random() * backoff * 0.25;
      const delayMs = Math.round(backoff + jitter);
      if (onRetry) onRetry({ attempt, delayMs, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** Resolve a promise or reject after `ms` with a tagged TimeoutError. */
function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = "ETIMEDOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { ocrLogger, createTrace, withRetry, withTimeout };
