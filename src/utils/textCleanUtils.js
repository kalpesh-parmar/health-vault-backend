const cleanOCRText = (data) => {
  return data
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/```json|```/g, "")
    .trim();
};

function stripThinking(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi, "")
    .replace(/<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

function sanitizeLLMOutput(text) {
  return stripThinking(text);
}

const SCRIPT_RANGES = {
  gujarati: /[\u0A80-\u0AFF]/g,
  gu: /[\u0A80-\u0AFF]/g,
  hindi: /[\u0900-\u097F]/g,
  hi: /[\u0900-\u097F]/g,
  marathi: /[\u0900-\u097F]/g,
  mr: /[\u0900-\u097F]/g,
  tamil: /[\u0B80-\u0BFF]/g,
  ta: /[\u0B80-\u0BFF]/g,
  telugu: /[\u0C00-\u0C7F]/g,
  te: /[\u0C00-\u0C7F]/g,
  kannada: /[\u0C80-\u0CFF]/g,
  kn: /[\u0C80-\u0CFF]/g,
  bengali: /[\u0980-\u09FF]/g,
  bn: /[\u0980-\u09FF]/g,
  punjabi: /[\u0A00-\u0A7F]/g,
  pa: /[\u0A00-\u0A7F]/g,
};

function validateIndicScriptRatio(text, targetLang, minRatio = 0.5) {
  if (!text || typeof text !== "string") return false;
  const norm = String(targetLang || "")
    .toLowerCase()
    .trim();
  if (norm === "en" || norm === "english") return true;

  const scriptRegex = SCRIPT_RANGES[norm];
  if (!scriptRegex) return true;

  const targetMatches = text.match(scriptRegex) || [];
  const latinMatches = text.match(/[a-zA-Z]/g) || [];
  const totalAlphabetic = targetMatches.length + latinMatches.length;

  if (totalAlphabetic === 0) return false;
  return targetMatches.length / totalAlphabetic >= minRatio;
}

module.exports = {
  cleanOCRText,
  stripThinking,
  sanitizeLLMOutput,
  validateIndicScriptRatio,
};
