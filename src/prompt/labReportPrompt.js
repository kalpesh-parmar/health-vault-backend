const buildLabReportPrompt = (ocrText, userMessage) => {
  return `
Analyze the lab report,
Based on ocr text and return it into valid JSON format
Provide:
- Abnormal values
- High/Low markers
- Important observations
- Easy explanation

User Query:
${userMessage}

OCR TEXT:
${ocrText}
`;
};

module.exports = buildLabReportPrompt;
