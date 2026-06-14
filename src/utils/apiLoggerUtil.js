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
 * Recursively clones and masks sensitive keys in objects, arrays, and stringified JSON.
 * @param {any} data
 * @returns {any}
 */
function maskSensitiveData(data) {
  if (!data) return data;

  if (typeof data === "string") {
    // Mask Bearer tokens
    if (data.toLowerCase().startsWith("bearer ")) {
      return "Bearer ***";
    }
    // Mask raw token or key parameters if the value looks like a secret
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(maskSensitiveData(parsed));
      }
    } catch {
      // not JSON
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveData(item));
  }

  if (typeof data === "object") {
    // Handle special Node.js objects safely
    if (
      data.constructor &&
      ["Buffer", "ReadStream", "WriteStream"].includes(data.constructor.name)
    ) {
      return `[${data.constructor.name}]`;
    }

    const masked = {};
    for (const key of Object.keys(data)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        masked[key] = "***";
      } else {
        masked[key] = maskSensitiveData(data[key]);
      }
    }
    return masked;
  }

  return data;
}

/**
 * Truncates payloads to a maximum length and returns a summary for binary/stream contents.
 * @param {any} payload
 * @param {number} maxLength
 * @returns {any}
 */
function truncatePayload(payload, maxLength = 1000) {
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
