const crypto = require("node:crypto");
const fs = require("node:fs");

const newFileKey = () => "doc_" + crypto.randomBytes(6).toString("hex");
const newBatchId = () => "bat_" + crypto.randomBytes(5).toString("hex");

function normalizeFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files === "object" && files.originalname) return [files];
  return Object.values(files).flat();
}

/**
 * Extracts total document page count.
 * Uses pdf-parse for PDF documents and defaults to 1 for images or on failure.
 * @param {Object|Buffer|string} file - file object, buffer, or file path
 * @returns {Promise<number>} total page count (at least 1)
 */
async function getPageCount(file) {
  if (!file) return 1;

  let buffer = null;
  let isPdf = false;

  if (Buffer.isBuffer(file)) {
    buffer = file;
    isPdf = buffer.length >= 4 && buffer.subarray(0, 4).toString() === "%PDF";
  } else if (typeof file === "string") {
    if (file.toLowerCase().endsWith(".pdf")) isPdf = true;
    try {
      buffer = await fs.promises.readFile(file);
      if (!isPdf && buffer.length >= 4 && buffer.subarray(0, 4).toString() === "%PDF") {
        isPdf = true;
      }
    } catch {
      return 1;
    }
  } else if (typeof file === "object") {
    const mime = (file.mimetype || file.mimeType || "").toLowerCase();
    const name = (
      file.originalname ||
      file.fileName ||
      file.filename ||
      file.name ||
      ""
    ).toLowerCase();
    isPdf = mime === "application/pdf" || name.endsWith(".pdf");

    if (Buffer.isBuffer(file.buffer)) {
      buffer = file.buffer;
    } else if (file.path) {
      try {
        buffer = await fs.promises.readFile(file.path);
      } catch {
        return 1;
      }
    }
  }

  if (isPdf && buffer) {
    try {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      const count = Number(data?.numpages);
      if (Number.isFinite(count) && count > 0) {
        return count;
      }
    } catch {
      return 1;
    }
  }

  return 1;
}

module.exports = { newFileKey, newBatchId, normalizeFiles, getPageCount };
