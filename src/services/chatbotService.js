const { InvalidRequestException } = require("../exceptions/appError");
const chatbotRepository = require("../repositories/chatbotRepository");
const documentRepository = require("../repositories/documentRepository");
const { errorConstants } = require("../constants/errorConstants");
const { model } = require("../configs/aiConfig");
const { cleanOCRText } = require("../utils/textCleanUtils");
const { detectIntent } = require("./aiService/intentDetection");
const { getPromptByIntent } = require("./aiService/promptFinder");

class chatbotService {
  async generateSummary(userId, data) {
    // console.log("documentId==", docId);
    // console.log("userId===",userId);

    const { documentId } = data;
    const { message } = data;
    const existingData = await documentRepository.findById(documentId);

    if (!existingData || existingData.userId != userId)
      throw new InvalidRequestException(errorConstants.DOCUMENT_NOT_FOUND);

    // const docData = existingData.ocrExtractedText;
    // console.log("documentData===", docData);
    //detect Intent
    const intent = await detectIntent(message);
    //find suitable prompt
    const prompt = getPromptByIntent({
      intent,
      ocrText: existingData.ocrExtractedText,
      message,
    });
    // const prompt=buildSummaryPrompt(message,docData);
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    // console.log("response==",response);

    const cleanResponse = cleanOCRText(response);
    // const parsedResponse = JSON.parse(cleanResponse);

    return chatbotRepository.createSummary({
      userId,
      Message: message,
      aiSummaryData: cleanResponse,
    });
  }
}
module.exports = new chatbotService();
