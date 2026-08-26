/**
 * Database date and timestamp boundary coercion utility.
 *
 * Ensures values passed to Drizzle ORM `date` and `timestamp` columns (mode: 'date')
 * are valid JavaScript Date instances anchored in UTC, preventing runtime
 * `value.toISOString is not a function` and `RangeError: Invalid time value` exceptions.
 */

function toDbDate(value, context = {}) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      logInvalidDate(value, context);
      return null;
    }
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      logInvalidDate(value, context);
      return null;
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      logInvalidDate(value, context);
      return null;
    }
    return d;
  }

  if (typeof value !== "string") {
    logInvalidDate(value, context);
    return null;
  }

  const raw = value.trim();
  if (!raw) return null; // Genuine empty/whitespace values are silent nulls

  // Pattern 1: ISO date-only "YYYY-MM-DD" (strictly anchored to UTC midnight)
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const y = +m[1];
    const mo = +m[2] - 1;
    const d = +m[3];
    const dt = new Date(Date.UTC(y, mo, d));

    // Reject rollover dates like 2025-02-30 that Date.UTC silently shifts to March
    if (
      Number.isNaN(dt.getTime()) ||
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() !== mo ||
      dt.getUTCDate() !== d
    ) {
      logInvalidDate(raw, context);
      return null;
    }
    return dt;
  }

  // Pattern 2: Full ISO datetime strings or standard parsable strings
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    logInvalidDate(raw, context);
    return null;
  }

  return parsed;
}

function logInvalidDate(raw, context = {}) {
  const docId = context.documentId || context.docId || context.fileKey || null;
  console.warn(
    JSON.stringify({
      level: "warn",
      code: "INVALID_DATE_COERCION",
      docId,
      raw: typeof raw === "object" ? JSON.stringify(raw) : String(raw),
    }),
  );
}

// toDbTimestamp is an alias to toDbDate for explicit naming intent
const toDbTimestamp = toDbDate;

module.exports = {
  toDbDate,
  toDbTimestamp,
};
