"use strict";

/**
 * PHI Model Guard
 * Prevents inadvertent routing of Protected Health Information (PHI)
 * to cloud-hosted/remote models (e.g., *-cloud tags) on Ollama.
 *
 * @param {string} modelTag
 * @param {string} purpose
 * @throws {Error} if modelTag contains 'cloud'
 */
function assertNonCloudModel(modelTag, purpose = "general AI") {
  if (!modelTag || typeof modelTag !== "string") {
    return;
  }

  if (/cloud/i.test(modelTag)) {
    throw new Error(
      `[SECURITY_VIOLATION] Model '${modelTag}' configured for ${purpose} matches cloud pattern (/cloud/i). ` +
        `Patient data (PHI) must never be transmitted to external/cloud-proxied models.`,
    );
  }
}

module.exports = {
  assertNonCloudModel,
};
