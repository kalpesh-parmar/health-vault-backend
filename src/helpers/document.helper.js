const { fileTypeValue } = require("../enums/fileType");

const MIME_BY_EXTENSION = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
]);

function inferFileType(mimeType, fallbackNull = false) {
  if (!mimeType) return fallbackNull ? null : fileTypeValue[0];
  const lower = String(mimeType).toLowerCase().trim();
  const found = fileTypeValue.find((type) => type.toLowerCase() === lower);
  if (found) return found;
  return fallbackNull ? null : fileTypeValue[0];
}

function inferMimeType(fileKey, explicitMimeType) {
  if (explicitMimeType) return explicitMimeType;
  const cleanKey = String(fileKey || "")
    .split("?")[0]
    .toLowerCase();
  const dot = cleanKey.lastIndexOf(".");
  if (dot >= 0) {
    return MIME_BY_EXTENSION.get(cleanKey.slice(dot)) || "application/pdf";
  }
  return "application/pdf";
}

function buildPatientSuggestions(extracted, patient) {
  const suggestions = {};
  if (extracted?.bloodGroup && extracted.bloodGroup !== patient?.bloodGroup) {
    suggestions.bloodGroup = extracted.bloodGroup;
  }
  const extAllergies = Array.isArray(extracted?.allergies) ? extracted.allergies : [];
  const patAllergies = Array.isArray(patient?.allergies) ? patient.allergies : [];
  const newAllergies = extAllergies.filter(
    (allergy) =>
      allergy &&
      !patAllergies.some(
        (existing) => String(existing).toLowerCase() === String(allergy).toLowerCase(),
      ),
  );
  if (newAllergies.length) suggestions.allergies = newAllergies;
  return suggestions;
}

function asText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value || null;
}

module.exports = {
  inferFileType,
  inferMimeType,
  buildPatientSuggestions,
  asText,
};
