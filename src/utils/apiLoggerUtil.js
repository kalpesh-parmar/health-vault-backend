const SENSITIVE_KEYS = new Set([
  "authorization",
  "password",
  "token",
  "apikey",
  "aiapikey",
  "client_secret",
  "otp",
  "accesstoken",
  "refreshtoken",
  "secret",
  "email_password",
  "smtppassword",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "gcpcredentialsbase64",
  "firebasecredentialsbase64",
]);

/**
 * Checks if the current environment requires masking sensitive fields.
 * Masking is enabled for all environments except explicit local 'development'.
 * @returns {boolean}
 */
function shouldMask() {
  return process.env.NODE_ENV !== "development";
}

/**
 * Recursively clones and masks sensitive keys in objects, arrays, and stringified JSON.
 * If the environment is 'development', it returns a clean copy of the original values unmasked.
 * @param {any} data
 * @param {WeakSet} [visited]
 * @returns {any}
 */
function maskSensitiveData(data, visited = new WeakSet()) {
  if (!data) return data;

  if (typeof data !== "object") {
    if (typeof data === "string") {
      // Mask Bearer tokens
      if (data.toLowerCase().startsWith("bearer ")) {
        return "Bearer ***";
      }
      // Mask raw token or key parameters if the value looks like a secret
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify(maskSensitiveData(parsed, visited));
        }
      } catch {
        // not JSON
      }
    }
    return data;
  }

  // Prevent infinite recursion on circular references
  if (visited.has(data)) {
    return "[Circular]";
  }

  // Handle special Node.js objects, Streams, and Sockets safely without recursing into them
  if (
    (data.constructor &&
      [
        "Buffer",
        "ReadStream",
        "WriteStream",
        "IncomingMessage",
        "Socket",
        "ClientRequest",
        "TLSSocket",
      ].includes(data.constructor.name)) ||
    typeof data.pipe === "function" ||
    data._readableState ||
    data._writableState
  ) {
    if (!shouldMask()) {
      return data;
    }
    return `[${data.constructor?.name || "Stream"}]`;
  }

  visited.add(data);

  // If in local development, skip masking (log actual values)
  if (!shouldMask()) {
    if (Array.isArray(data)) {
      return data.map((item) => maskSensitiveData(item, visited));
    }
    const clone = {};
    for (const key of Object.keys(data)) {
      clone[key] = maskSensitiveData(data[key], visited);
    }
    return clone;
  }

  // Production/Masking flow
  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveData(item, visited));
  }

  const masked = {};
  for (const key of Object.keys(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      const val = data[key];
      if (typeof val === "string" && val.toLowerCase().startsWith("bearer ")) {
        masked[key] = "Bearer ***";
      } else {
        masked[key] = "***";
      }
    } else {
      masked[key] = maskSensitiveData(data[key], visited);
    }
  }
  return masked;
}

/**
 * Truncates payloads to a maximum length and returns a summary for binary/stream contents.
 * @param {any} payload
 * @param {number} maxLength
 * @returns {any}
 */
function truncatePayload(payload, maxLength = 7000) {
  if (!payload) return payload;

  if (typeof payload === "string") {
    if (payload.length > maxLength) {
      return payload.slice(0, maxLength) + `... [TRUNCATED - Total length: ${payload.length}]`;
    }
    return payload;
  }

  if (typeof payload === "object") {
    if (payload.constructor && payload.constructor.name === "Buffer") {
      return `[Buffer - Size: ${payload.length} bytes]`;
    }
    if (payload.constructor && payload.constructor.name.includes("Stream")) {
      return `[Stream]`;
    }

    try {
      const serialized = JSON.stringify(payload);
      if (serialized.length > maxLength) {
        return (
          serialized.slice(0, maxLength) + `... [TRUNCATED - Total length: ${serialized.length}]`
        );
      }
      return payload;
    } catch {
      return "[Unserializable Payload]";
    }
  }

  return payload;
}

module.exports = {
  maskSensitiveData,
  truncatePayload,
};
