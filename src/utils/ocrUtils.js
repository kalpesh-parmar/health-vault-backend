const Tesseract = require("tesseract.js");

const extractTextFromImage = async (filePath) => {
  const result = await Tesseract.recognize(filePath, "eng");

  return result.data.text;
};

module.exports = { extractTextFromImage };
