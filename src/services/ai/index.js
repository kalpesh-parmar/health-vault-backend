const { ocrService } = require("./ocr/ocr.service");
const { ocrOrchestrator } = require("./ocr/ocr.orchestrator");
const { chatService } = require("./chat/chat.service");
const { onboardingService } = require("./chat/onboarding.service");
const { embeddingService } = require("./chat/embedding.service");
const {
  medicalDocumentClassifierService,
} = require("./classifier/medicalDocumentClassifier.service");
const aiClient = require("./clients/aiClient.service");
const { ollamaClient } = require("../../clients/ollamaClient");
const aiModelFactory = require("./factories/aiModelFactory");
const medicationMapper = require("./helpers/medicationMapper");

module.exports = {
  ocrService,
  ocrOrchestrator,
  chatService,
  onboardingService,
  embeddingService,
  medicalDocumentClassifierService,
  aiClient,
  ollamaClient,
  aiModelFactory,
  medicationMapper,
};
