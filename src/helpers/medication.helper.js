function normalizeMedicationName(name) {
  if (!name || typeof name !== "string") return "";
  let clean = name.toLowerCase().trim();
  clean = clean.replace(
    /^(?:tab\.|tablet|tab|cap\.|capsule|caps|cap|syp\.|syrup|syp|inj\.|injection|inj|drops?|drop|spray|inhaler|inh\.|inh)\s+/i,
    "",
  );
  clean = clean.replace(/\b\d+(\.\d+)?\s*(mg|g|mcg|ml|iu|puffs?)?\b/gi, "");
  clean = clean
    .replace(/[^a-z0-9\s]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean;
}

module.exports = {
  normalizeMedicationName,
};
