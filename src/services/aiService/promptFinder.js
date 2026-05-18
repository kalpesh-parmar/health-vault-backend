const buildSummaryPrompt = require("../../prompt/summaryDataPrompt");
const buildMedicationPrompt = require("../../prompt/medicationPrompt");
const buildDiagnosisPrompt = require("../../prompt/diagnosisPrompt");
const buildLabReportPrompt = require("../../prompt/labReportPrompt");

const getPromptByIntent = ({ intent, ocrText, userMessage }) => {
  switch (intent) {
    case "SUMMARY":
      return buildSummaryPrompt(ocrText, userMessage);

    case "MEDICATION":
      return buildMedicationPrompt(ocrText, userMessage);

    case "DIAGNOSIS":
      return buildDiagnosisPrompt(ocrText, userMessage);

    case "LAB_REPORT":
      return buildLabReportPrompt(ocrText, userMessage);

    default:
      return buildSummaryPrompt(ocrText, userMessage);
  }
};

module.exports = {
  getPromptByIntent,
};
