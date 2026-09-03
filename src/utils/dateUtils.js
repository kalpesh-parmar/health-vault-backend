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

function normalizeToDateOnly(input, context = {}) {
  if (input === null || input === undefined) return null;

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      logInvalidDate(input, context);
      return null;
    }
    const y = input.getUTCFullYear();
    const mo = String(input.getUTCMonth() + 1).padStart(2, "0");
    const d = String(input.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  if (typeof input !== "string") {
    if (typeof input === "number" && Number.isFinite(input)) {
      return normalizeToDateOnly(new Date(input), context);
    }
    logInvalidDate(input, context);
    return null;
  }

  const raw = input.trim();
  if (!raw) return null;

  // Pattern 1: ISO or leading YYYY-MM-DD (e.g. "2024-04-08", "2024-04-08 00:00:00", "2024-04-08T00:00:00Z")
  const mIso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) {
    const y = +mIso[1];
    const mo = +mIso[2];
    const d = +mIso[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // Pattern 2: DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const mDmy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (mDmy) {
    const d = +mDmy[1];
    const mo = +mDmy[2];
    const y = +mDmy[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // Pattern 3: DD-Mon-YYYY (e.g. "08-Apr-2024", "08 Apr 2024")
  const mMon = raw.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{4})/);
  if (mMon) {
    const monthNames = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
      january: 1,
      february: 2,
      march: 3,
      april: 4,
      june: 6,
      july: 7,
      august: 8,
      september: 9,
      october: 10,
      november: 11,
      december: 12,
    };
    const d = +mMon[1];
    const monStr = mMon[2].toLowerCase();
    const y = +mMon[3];
    const mo = monthNames[monStr];
    if (mo && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // Fallback: Attempt standard Date parsing
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const mo = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    const d = String(parsed.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  logInvalidDate(raw, context);
  return null;
}

function toDbDateOnlyString(dateInput) {
  if (dateInput === null || dateInput === undefined) return null;
  return normalizeToDateOnly(dateInput);
}

// toDbTimestamp is an alias to toDbDate for explicit naming intent
const toDbTimestamp = toDbDate;

module.exports = {
  toDbDate,
  toDbTimestamp,
  normalizeToDateOnly,
  toDbDateOnlyString,
};
