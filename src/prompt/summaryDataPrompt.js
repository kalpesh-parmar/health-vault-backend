const buildSummaryPrompt = (ocrText, message) => `
        You are an AI healthcare assistant.

        Analyze the following medical report.
        and return it in valid JSON format
        Format:
            {
              "summary": "",
              "importantFindings": [],
              "simpleExplanation": []
            }
        Keep response simple and user friendly.
        userMessage:
        ${message}
        ocrText:
        ${ocrText}`;
module.exports = buildSummaryPrompt;
