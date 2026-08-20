const crypto = require("node:crypto");

const newFileKey = () => "doc_" + crypto.randomBytes(6).toString("hex");
const newBatchId = () => "bat_" + crypto.randomBytes(5).toString("hex");

function normalizeFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files === "object" && files.originalname) return [files];
  return Object.values(files).flat();
}

module.exports = { newFileKey, newBatchId, normalizeFiles };
