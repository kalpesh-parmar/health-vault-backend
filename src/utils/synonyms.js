const KEYWORD_SYNONYMS = {
  hemoglobin: ["hemoglobin", "haemoglobin", "hb", "hgb"],
  rbc: ["rbc", "red blood cell", "red blood cells"],
  "vitamin d": ["vitamin d", "vit d", "vitamin-d", "vit-d"],
  wbc: ["wbc", "white blood cell", "white blood cells"],
  platelets: ["platelet", "platelets"],
  creatinine: ["creatinine"],
  tsh: ["tsh", "thyroid"],
  cholesterol: ["cholesterol", "ldl", "hdl", "triglyceride", "triglycerides", "lipid", "lipids"],
};

/**
 * Expands a list of entities (or single entity) into their synonyms.
 * @param {string[]|string} entities - The list of entities to expand.
 * @returns {string[]} An array of all expanded synonyms.
 */
function expandSynonyms(entities) {
  if (!entities) return [];
  const list = Array.isArray(entities) ? entities : [entities];
  const result = new Set();
  for (const entity of list) {
    const key = entity.toLowerCase().trim();
    const synonyms = KEYWORD_SYNONYMS[key];
    if (synonyms) {
      synonyms.forEach((syn) => result.add(syn));
    } else {
      result.add(key);
    }
  }
  return Array.from(result);
}

/**
 * Checks if a given text content contains an entity (accounting for synonyms).
 * @param {string} content - The text content to search.
 * @param {string} entity - The normalized entity key.
 * @returns {boolean} True if the entity or any of its synonyms are found.
 */
function containsEntity(content, entity) {
  if (!content || !entity) return false;
  const synonyms = KEYWORD_SYNONYMS[entity.toLowerCase().trim()] || [entity];
  const lowerContent = content.toLowerCase();
  return synonyms.some((syn) => lowerContent.includes(syn.toLowerCase()));
}

module.exports = {
  KEYWORD_SYNONYMS,
  expandSynonyms,
  containsEntity,
};
