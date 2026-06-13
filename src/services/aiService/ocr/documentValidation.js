const { env } = require("../../../configs/env");
const { CorruptedFileError, FileTooLargeError, UnsupportedDocumentError } = require("./ocrErrors");

const PDF_MIME = "application/pdf";

const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/tif", "image/tiff"],
  ["image/x-tiff", "image/tiff"],
]);

const EXTENSION_TO_MIME = new Map([
  [".pdf", PDF_MIME],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

// The configured AI model accepts these for inline document/vision processing.
const SUPPORTED_MIME = new Set([PDF_MIME, "image/png", "image/jpeg", "image/webp"]);

const SUPPORTED_MESSAGE = "Supported types: PDF, PNG, JPG, JPEG, WEBP";

// Magic-byte signatures used as a lightweight corruption / type sanity check.
const SIGNATURES = [
  { mime: PDF_MIME, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
];

function normalizeMime(filename, mimeType) {
  const explicit = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  let value = explicit;
  if (!value) {
    const clean = String(filename || "")
      .split("?")[0]
      .toLowerCase();
    const dot = clean.lastIndexOf(".");
    if (dot >= 0) value = EXTENSION_TO_MIME.get(clean.slice(dot)) || "";
  }
  return MIME_ALIASES.get(value) || value;
}

function detectSignatureMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) return sig.mime;
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  // TIFF: II*\0 or MM\0*
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00)
  ) {
    return "image/tiff";
  }
  return null;
}

/**
 * Validate a document buffer + declared type before OCR.
 *
 * @returns {{ mimeType:string }}
 * @throws  {CorruptedFileError|UnsupportedDocumentError|FileTooLargeError}
 */
function validateDocument({ buffer, filename, mimeType }) {
  if (!buffer || buffer.length === 0) {
    throw new CorruptedFileError("File is empty", { filename });
  }
  if (buffer.length > env.aiMaxInlineBytes) {
    throw new FileTooLargeError(
      `File exceeds the ${Math.round(env.aiMaxInlineBytes / (1024 * 1024))}MB limit`,
      { filename, size: buffer.length, limit: env.aiMaxInlineBytes },
    );
  }

  let resolved = normalizeMime(filename, mimeType);
  const signatureMime = detectSignatureMime(buffer);

  // If the declared type is missing/unknown, trust the magic bytes.
  if (!resolved && signatureMime) resolved = signatureMime;

  // If declared type and magic bytes disagree on the broad family, the file
  // is likely corrupted or mislabelled — prefer the signature when present.
  if (signatureMime && resolved && signatureMime !== resolved) {
    resolved = signatureMime;
  }

  if (!resolved) {
    throw new UnsupportedDocumentError(`Unknown document type. ${SUPPORTED_MESSAGE}`, { filename });
  }
  if (!SUPPORTED_MIME.has(resolved)) {
    throw new UnsupportedDocumentError(
      `Unsupported document type '${resolved}'. ${SUPPORTED_MESSAGE}`,
      {
        filename,
        mimeType: resolved,
      },
    );
  }

  return { mimeType: resolved };
}

module.exports = {
  validateDocument,
  normalizeMime,
  detectSignatureMime,
  PDF_MIME,
  SUPPORTED_MESSAGE,
};
