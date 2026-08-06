const medicalPrompt = (ocrText, graphSummary = "") => `
You are a medical OCR extraction AI.

Convert the medical OCR text into valid JSON.

Rules:
- Return ONLY valid JSON
- No markdown
- No explanation
- Use null if value missing
- Keep exact medical values
- Keep units exactly

Extract:
details based on json format required

JSON FORMAT:

{
  "patient": {
    "name": null,
    "age": null,
    "gender": null
  },

  "doctor": {
    "name": null
  },

  "hospital": {
    "name": null
  },

  "report": {
    "type": null,
    "date": null
  },

  "parameters": [
    {
      "name": null,
      "value": null,
      "unit": null,
      "status": null
    }
  ],

  "medicines": [
    {
      "name": null,
      "dosage": null,
      "frequency": null
    }
  ],

  "diagnosis": [],

  "observations": [],

  "graphs": [
    {
      "type": null,
      "observation": null,
      "trend": null
    }
  ]
}

OCR TEXT:
${ocrText}

GRAPH SUMMARY:
${graphSummary}

Return ONLY JSON.
`;
const cleanOCRText = (data) => {
  return (
    data
      .replace(/```json/g, "")
      .replace(/```/g, "")
      // .replace(/\s+/g, " ")
      // .replace(/[_]{2,}/g, "")
      // .replace(/[^\w\s.,:%()/+-]/g, "")
      .trim()
  );
};
module.exports = { medicalPrompt, cleanOCRText };
