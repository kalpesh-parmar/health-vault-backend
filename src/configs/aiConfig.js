const { env } = require("./env");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// const AI_CONFIG = {
//   OLLAMA_URL:env.ollamaUrl,
//   MODELS: {
//     OCR: env.ocrModel,
//     CHAT: env.chatModel,
//     CODE: env.codeModel,
//     VISION: env.visionModel,}, };
const generativeAi = new GoogleGenerativeAI(env.apiKey);
const model = generativeAi.getGenerativeModel({
  model: "gemini-2.5-flash",
});
module.exports = { model };
