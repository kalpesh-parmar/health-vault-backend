# Multilingual Scanned Indic Golden Corpus (`golden_scanned`)

**Milestone:** v7.0 — Multilingual OCR Accuracy and Reliability  
**Corpus Root:** `health-vault-backend/ai-service/tests/fixtures/golden_scanned/`

---

## 1. Directory Structure

```
golden_scanned/
├── en/                           # English scans (5 genuine clinical scans - GITIGNORED for PHI)
├── gu/                           # Gujarati scans (1 English-printed clinic scan [0 Gujarati glyphs] - GITIGNORED; 4 synthetic directional)
├── hi/                           # Hindi scans (5 synthetic directional clinical documents)
├── mr/                           # Marathi scans (5 synthetic directional clinical documents)
├── ta/                           # Tamil scans (5 synthetic directional clinical documents)
├── ablation/                     # Skew ablation suite (0°, 5°, 15°, 45° rotation variants)
├── manifest.json                 # SHA-256 integrity manifest for all fixtures
└── README.md                     # This document
```

---

## 2. Invariants & Policies

### A. PHI Protection & Git Hygiene

- All real clinical document images/PDFs and their paired ground-truth files (`golden_scanned/en/`, `golden_scanned/gu/gu_01*`) contain private clinical information and **MUST NEVER be committed to Git**.
- They are excluded via `.gitignore`.
- _Note on Gujarati (`gu_01`):_ While `gu_01_quotation` is a genuine physical scan from an Ahmedabad dental clinic, the text is printed entirely in English (755 Latin characters, 0 Gujarati glyphs). Genuine **Gujarati-script scanned pages = 0** in this corpus; the 4 Indic Gujarati fixtures (`gu_02..05`) are synthetic directional.
- Synthetic documents (`hi`, `mr`, `ta`, and `gu_02..05`) contain 100% synthetic de-identified clinical text and may be tracked for regression reproducibility.

### B. Metadata Schema & Split Tagging

Every paired `.json` companion file follows this specification:

```json
{
  "docId": "hi_01_prescription",
  "language": "hi",
  "docType": "prescription",
  "status": "synthetic_directional_only",
  "provenance": "generated_source_text",
  "verified_by": "generator_v1",
  "seen_in_v6_tuning": false,
  "split": "synthetic",
  "groundTruthText": "...",
  "patientInfo": { ... },
  "medications": [ ... ],
  "labResults": [ ... ]
}
```

- **`status` Values:**
  - `"real_scanned"`: Genuine clinical physical scans or camera captures.
  - `"synthetic_directional_only"`: Programmatically rendered clinical documents with scanner noise simulation.
- **`provenance` Values:**
  - `"human_transcribed"`: Ground truth manually typed and verified by a human user.
  - `"generated_source_text"`: Verbatim underlying source text from the synthetic generator.
  - `"unverified_mined"`: Mined from legacy fixtures without verifiable human transcription.
- **`split` Values:**
  - `"synthetic"`: Directional synthetic pages (excluded from production gate thresholds).
  - `"baseline_tuning"`: Reused pages from existing workspace fixtures (`seen_in_v6_tuning: true`).
  - `"held_out"`: Newly sourced, held-out clinical pages.
- **Formal Gate Set:**
  $$\text{Gate Set} = \{\text{doc} \mid \text{status} == \text{"real_scanned"} \land \text{split} == \text{"held_out"} \land \text{verified\_by} \ne \text{null}\}$$
  _(Currently empty ($N = 0$) until real held-out scans are provided)._

---

## 3. Evaluation & Harness Execution

To evaluate multilingual OCR across this corpus:

```bash
python scripts/eval_multilingual_ocr.py --dataset health-vault-backend/ai-service/tests/fixtures/golden_scanned --report
```
