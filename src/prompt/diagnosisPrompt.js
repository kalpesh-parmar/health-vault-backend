const buildDiagnosisPrompt = (ocrText, userMessage) => {
  return `
Analyze the medical diagnosis from the OCR text.
And return the response in JSON format
Explain:
- Diagnosis
- Severity
- Important notes
- Simple explanation for patient

User Query:
${userMessage}

OCR TEXT:
${ocrText}
`;
};

module.exports = buildDiagnosisPrompt;
