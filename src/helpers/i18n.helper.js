const fs = require("fs");
const path = require("path");
const { normalizeLanguage } = require("../utils/commonUtils");

const cache = new Map();

function getLangCode(language) {
  const norm = normalizeLanguage(language);
  if (norm === "gujarati") return "gu";
  if (norm === "hindi") return "hi";
  if (norm === "marathi") return "mr";
  if (norm === "tamil") return "ta";
  return "en";
}

function loadI18nDictionary(langCode) {
  if (cache.has(langCode)) {
    return cache.get(langCode);
  }

  const filePath = path.resolve(__dirname, `../i18n/messages/${langCode}.json`);
  let dict = null;

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      dict = JSON.parse(content);
    } catch (err) {
      console.warn(`[i18nHelper] Failed to parse i18n file for ${langCode}:`, err.message);
    }
  }

  if (!dict && langCode !== "en") {
    dict = loadI18nDictionary("en");
  }

  if (!dict) {
    dict = {};
  }

  cache.set(langCode, dict);
  return dict;
}

function replacePlaceholders(template, placeholders = {}) {
  if (!template || typeof template !== "string") return "";
  let result = template;
  for (const [key, val] of Object.entries(placeholders)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(val));
  }
  return result;
}

function formatDocumentMedicationsExtractedReview(params, legacyCount, legacyLanguage) {
  if (typeof params === "object" && params !== null) {
    const {
      successfulCount = 0,
      totalCount = 0,
      medicationCount = 0,
      failedCount = 0,
      language,
      preferredLanguage,
    } = params;

    const langCode = getLangCode(language || preferredLanguage || legacyLanguage);
    const dict = loadI18nDictionary(langCode);
    const enDict = loadI18nDictionary("en");
    const section =
      dict.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW ||
      enDict.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW ||
      {};

    let msg = "";

    if (totalCount === 1) {
      if (successfulCount === 1) {
        msg = section.singleSuccess || "1 document processed successfully.";
      } else if (failedCount === 1) {
        msg = section.singleFailed || "1 document could not be processed.";
      } else {
        msg = replacePlaceholders(
          section.singlePartial || "{successfulCount} of {totalCount} documents processed.",
          {
            successfulCount,
            totalCount,
          },
        );
      }
    } else {
      msg = replacePlaceholders(
        section.multiSuccess ||
          "{successfulCount} of {totalCount} documents processed successfully.",
        {
          successfulCount,
          totalCount,
        },
      );
    }

    if (medicationCount > 0) {
      const template =
        medicationCount === 1
          ? section.medicationsFoundSingle || "\nWe found 1 medication for your review."
          : section.medicationsFoundPlural ||
            "\nWe found {medicationCount} medications for your review.";
      msg += replacePlaceholders(template, { medicationCount });
    } else if (successfulCount > 0) {
      msg += section.noMedicationsFound || "\nNo medications found for review.";
    }

    if (failedCount > 0 && totalCount > 1) {
      const template =
        failedCount === 1
          ? section.failedRetrySingle ||
            "\n1 document could not be processed. Please retry them below."
          : section.failedRetryPlural ||
            "\n{failedCount} documents could not be processed. Please retry them below.";
      msg += replacePlaceholders(template, { failedCount });
    }

    return msg;
  }

  const fileName = params || "document";
  const count = legacyCount || 0;
  const langCode = getLangCode(legacyLanguage);
  const dict = loadI18nDictionary(langCode);
  const enDict = loadI18nDictionary("en");
  const section =
    dict.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW ||
    enDict.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW ||
    {};

  const template =
    count > 1
      ? section.legacyMsgPlural ||
        "Document '{fileName}' has been processed. Found {count} medications in your document. Please review and confirm to add them to your active medications:"
      : section.legacyMsgSingle ||
        "Document '{fileName}' has been processed. Found {count} medication in your document. Please review and confirm to add them to your active medications:";

  return replacePlaceholders(template, { fileName, count });
}

module.exports = {
  getLangCode,
  loadI18nDictionary,
  formatDocumentMedicationsExtractedReview,
};
