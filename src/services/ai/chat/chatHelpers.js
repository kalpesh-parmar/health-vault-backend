/**
 * Safe shared helpers for chat and ragContext services.
 */

/**
 * Picks a localized string or template with fallback strictly to english.
 * @param {Record<string, any>} map
 * @param {string} lang
 * @returns {any}
 */
function pickLang(map, lang) {
  if (!map) return undefined;
  return map[lang] || map.english;
}

/**
 * Checks if a string contains any of the keywords in a list.
 * @param {string} text
 * @param {string[]} list
 * @returns {boolean}
 */
function hasAny(text, list) {
  if (!text || !Array.isArray(list)) return false;
  return list.some((kw) => text.includes(kw));
}

/**
 * Exact replica of inline date conversion:
 * x instanceof Date ? x.toISOString().split("T")[0] : String(x).split("T")[0]
 * @param {any} value
 * @returns {string}
 */
function toIsoDateOnly(value) {
  return value instanceof Date ? value.toISOString().split("T")[0] : String(value).split("T")[0];
}

module.exports = {
  pickLang,
  hasAny,
  toIsoDateOnly,
};
