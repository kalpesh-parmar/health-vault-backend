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

module.exports = {
  cleanOCRText,
  stripThinking,
  sanitizeLLMOutput,
};
