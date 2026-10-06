# Medical Report Processing Pipeline & Extraction Engine

This document defines the architecture, data contracts, status evaluation rules, and testing procedures for the Health Vault OCR extraction and structured report generation pipeline.

---

## 1. Architectural Pipeline Stages

The report processing pipeline ingests unstructured PDF and image medical reports, processes them through deterministic fastpaths or OCR neural models, and yields an evaluated clinical data payload.

```mermaid
flowchart TD
    Upload[Client Upload (PDF / Image)] --> Stage1[Stage 1: Validating]
    Stage1 --> FastPathGate{Direct Text Possible?}
    FastPathGate -- Yes --> Stage2Direct[Direct PyMuPDF Spatial Text Pipeline]
    FastPathGate -- No --> Stage2OCR[Stage 2: OCR Running (PaddleOCR / Vision)]
    Stage2Direct --> Stage3[Stage 3: Structuring & Spatial Row Clustering]
    Stage2OCR --> Stage3
    Stage3 --> Stage4[Stage 4: Lab Status & Range Evaluation]
    Stage4 --> Stage5[Stage 5: Clinical Summary & Deterministic Findings]
    Stage5 --> Stage6[Stage 6: Translation (EN / GU / HI)]
    Stage6 --> Client[Client API Response]
```

### Stage Breakdown

1. **Stage 1: Validating (`STAGE_VALIDATING`)**
   - **MIME & Type Verification**: Validates PDF/image payloads against supported formats.
   - **Fast Probe**: Evaluates whether born-digital text is present using PyMuPDF font corruption gates (`CID_CORRUPTION`, `UNICODE_REPLACEMENT`, `PHONOTACTIC_GARBLE`).
   - **Medical Document Classification**: Rejects non-medical invoices or receipts.

2. **Stage 2: OCR Extraction (`STAGE_OCR_RUNNING`)**
   - **Direct Text Fastpath**: When all pages satisfy lexical confidence ($\ge 80$ alnum characters, low garble ratio), text is directly extracted with word coordinates in $<1.5\text{s}$.
   - **Vision OCR Fallback**: For scanned documents, pages are preprocessed (OpenCV deskew when enabled) and routed to PaddleOCR or Vision models.

3. **Stage 3: Spatial Row Clustering (`SpatialRowBuilder`)**
   - Clusters word bounding boxes by horizontal $y$-bands using median word height tolerance ($0.55\times\text{median}$).
   - Assigns column anchors ($x$-coordinates) for Analyte Name, Value Raw, Flag, Unit, and Reference Range.
   - Cleans background watermarks and tracking tokens.
   - Separates assay methodology (e.g. HPLC, CLIA, Photometric) from test names.

4. **Stage 4: Lab Status Evaluation (`LabEvaluator`)**
   - Evaluates numeric values against printed or clinical reference ranges.
   - Computes status classifications (`low`, `normal`, `high`, `borderline`, `borderline_high`, `diabetic`, `prediabetic`, `no_range`).
   - Generates multi-tier diagnostic schemas (e.g. for HbA1c).

5. **Stage 5: Deterministic Findings Generation (`SummaryStageHandler`)**
   - Grounds summary generation strictly in evaluated findings from Stage 4.
   - Prioritizes clinically abnormal analytes (significant deviations before borderline).

6. **Stage 6: Multilingual Translation (`TranslationService`)**
   - Translates findings and clinical notes into Gujarati (`gu`) or Hindi (`hi`) using IndicTrans2 / local models.
   - Preserves Western Arabic digits (`11.20`, `271`) and lab units per medical conventions.

---

## 2. Lab Status Resolution & Clinical Evaluation Rules

### Evaluated Status Enum

- `low`: Parameter falls strictly below the reference range lower bound (e.g. Hemoglobin $11.20 < 12.0$).
- `normal`: Parameter resides comfortably within normal corridor ($10\% - 90\%$ range interval).
- `high`: Parameter exceeds reference range upper bound (e.g. RBS $185 > 140$).
- `borderline`: Parameter within 5% of range lower bound (e.g. RBC $3.80 \approx 3.80$).
- `borderline_high`: Parameter within 5% of range upper bound (e.g. PT $14.8 \approx 15.0$).
- `prediabetic`: Diagnostic tier for HbA1c between $5.7\% - 6.4\%$.
- `diabetic`: Diagnostic tier for HbA1c $\ge 6.5\%$ or RBS $\ge 200\text{ mg/dL}$.
- `no_range`: No validated reference interval available; flags for clinical contextual review.

### Special Analyte Rules

- **International Normalized Ratio (INR)**:
  - By default (`ENABLE_GENERIC_INR_RANGE=false`), reference range is preserved as `null`.
  - The UI presents: `"Target depends on clinical indication (e.g. Warfarin therapy: 2.0 - 3.0)"` to prevent false abnormal alarms on anticoagulated patients.
- **Hemoglobin A1c (HbA1c)**:
  - Evaluated against 3 discrete diagnostic tiers:
    - Normal: $< 5.7\%$
    - Prediabetic: $5.7\% - 6.4\%$
    - Diabetic: $\ge 6.5\%$
  - Emits `tiers` array in the payload for segmented rendering. Emits unit warning if printed in non-standard units (e.g. $\text{mg/dL}$).

---

## 3. Data Contract Specification

### Grouped Section Payload Schema (Backend $\rightarrow$ Frontend)

```json
{
  "documentId": "doc_abc123",
  "patientInfo": {
    "name": "Patient Name",
    "age": 70,
    "gender": "female",
    "uhid": "UHID-00000",
    "doctorName": "Dr. Referring Doctor"
  },
  "reportDate": "2024-08-30",
  "labName": "Central Diagnostic Laboratory",
  "statusCounts": {
    "abnormal": 4,
    "borderline": 2,
    "normal": 26
  },
  "sections": [
    {
      "key": "hematology",
      "displayName": "Hematology",
      "analytes": [
        {
          "testName": "Hemoglobin",
          "value": 11.2,
          "valueRaw": "11.20",
          "unit": "gm/dL",
          "status": "low",
          "referenceRange": "12.0 - 15.0",
          "rangeLow": 12.0,
          "rangeHigh": 15.0,
          "method": "Photometric",
          "flag": "L"
        }
      ]
    }
  ],
  "keyFindings": [
    "Mild anemia: Hemoglobin is 11.2 gm/dL (slightly below normal range 12.0 - 15.0)."
  ]
}
```

---

## 4. How to Extend the Pipeline

### Adding a New Supported Language

1. **Frontend Dictionary**: Add translations to `health-vault-frontend/src/i18n/reportCardI18n.ts` under the language code (e.g. `mr` for Marathi, `ta` for Tamil).
2. **Translation Verification**: Run `npm run test:i18n` in `health-vault-backend` to ensure key parity.
3. **Typography**: Ensure font rendering supports the target Indic script and sets `lineHeight >= 1.5x fontSize`.

### Adding a New Lab Format or Analyte

1. **Analyte Alias Map**: Register alternative naming conventions in `ai-service/app/services/pipeline/lab_evaluator.py` under `CLINICAL_CANONICAL_MAP`.
2. **Clinical Range**: Add canonical adult reference intervals to `CLINICAL_REFERENCE_RANGES`.
3. **Unit Normalization**: If custom symbols or assay codes are used, map them in `SpatialRowBuilder.normalize_unit`.
4. **Glossary Entry**: Add layman explanation in `health-vault-frontend/src/components/ReportCard/Glossary.ts`.

---

## 5. Verification & Test Execution

### Running the Test Suites

```bash
# Frontend Unit Tests & TypeScript Verification
cd health-vault-frontend
npm test
npx tsc --noEmit

# Backend Integration & Redaction Tests
cd health-vault-backend
npm run test:unit -- tests/unit/logRedaction.test.js

# AI-Service Pytest Suite
cd health-vault-backend/ai-service
.\venv\Scripts\python.exe -m pytest -k "test_fixture_extraction_and_status or test_lab_status_resolution or test_logging_redaction"

# Offline Fixture Redaction & Zero-PHI Verification
cd health-vault-backend/ai-service
.\venv\Scripts\python.exe scripts/redactFixture.py --test-fixtures
```
