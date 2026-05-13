const medicalPrompt = (full_text, graphs) =>
  `
You are a highly advanced AI medical document extraction system.

Your task is to analyze OCR-extracted medical report text and graph/chart data and convert it into structured medical JSON.

IMPORTANT RULES:
- Return ONLY valid JSON
- Do NOT return markdown
- Do NOT use \`\`\`
- Do NOT add explanation
- Do NOT add notes outside JSON
- Do NOT hallucinate values
- If value is missing return null
- Preserve medical accuracy
- Detect medical context intelligently
- Detect tabular data logically
- Detect graph/chart trends logically
- Maintain consistent JSON structure

ANALYSIS REQUIREMENTS:

1. Extract Hospital Information
- hospitalName
- hospitalAddress
- hospitalContact
- labName

2. Extract Patient Information
- patientName
- age
- gender
- patientId
- referredBy
- registrationNumber

3. Extract Doctor Information
- doctorName
- specialization

4. Extract Report Information
- reportType
- reportDate
- collectionDate
- reportStatus

5. Extract Medical Parameters
For every detected parameter extract:
- name
- value
- unit
- referenceRange
- status (Low/Normal/High/Critical)
- category

6. Detect Abnormal Findings
- abnormalParameters
- criticalObservations

7. Extract Clinical Information
- diagnosis
- symptoms
- observations
- conclusion
- remarks
- recommendations

8. Extract Medicines
- medicineName
- dosage
- frequency

9. Detect Tables
Convert table-like OCR into structured arrays.

10. Graph/Chart Analysis
Analyze graph/chart data logically.

If graph exists:
- identify graph type
- identify trend
- identify increasing/decreasing values
- identify abnormalities
- generate medical observation summary

Examples:
- ECG trend
- Sugar level trend
- Heart rate variation
- Blood pressure trend
- Cholesterol trend

11. ECG Analysis
If ECG-like data exists:
- detect rhythm
- detect abnormalities
- detect rate patterns
- generate ECG observations

12. Confidence Scoring
Add confidence score from 0-100 for extracted data quality.

RETURN JSON FORMAT EXACTLY LIKE THIS:

{
  "hospital": {
    "name": null,
    "address": null,
    "contact": null,
    "labName": null
  },
  "patient": {
    "name": null,
    "age": null,
    "gender": null,
    "patientId": null,
    "registrationNumber": null
  },
  "doctor": {
    "name": null,
    "specialization": null,
    "referredBy": null
  },
  "report": {
    "reportType": null,
    "reportDate": null,
    "collectionDate": null,
    "reportStatus": null
  },
  "parameters": [
    {
      "name": null,
      "value": null,
      "unit": null,
      "referenceRange": null,
      "status": null,
      "category": null
    }
  ],
  "abnormalFindings": [],
  "criticalObservations": [],
  "diagnosis": [],
  "symptoms": [],
  "medicines": [],
  "remarks": null,
  "conclusion": null,
  "recommendations": [],
  "tables": [],
  "graphs": [
    {
      "graphType": null,
      "observation": null,
      "trend": null,
      "abnormality": null
    }
  ],
  "ecgAnalysis": {
    "rhythm": null,
    "heartRate": null,
    "interpretation": null, 
    "abnormalities": []
  },
  "documentConfidence": null
}

OCR TEXT:
${full_text}

GRAPH DATA:
${JSON.stringify(graphs)}

Return ONLY valid JSON.
`;
const cleanOCRText = (data) => {
  return data
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/```json|```/g, "")
    .trim();
};
module.exports = { medicalPrompt, cleanOCRText };
