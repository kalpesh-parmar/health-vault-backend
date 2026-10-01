# PDF Text Layer Test Cases

This directory contains synthetic, reproducible test PDF fixtures designed to validate the text-layer sanitization and per-page garble gate (`pdf_text.py` and `ocr_stage.py`):

| Fixture File | Pages | Description | Expected Gate Classification |
| :--- | :--- | :--- | :--- |
| `clean_born_digital.pdf` | 2 | Clean English CBC and LFT laboratory report with standard fonts and dense medical values. | **100% `pymupdf_direct`** (latency < 50ms per page, 0% OCR fallback). |
| `cid_corrupted.pdf` | 1 | Born-digital PDF with `(cid:...)` tokens resulting from missing ToUnicode CMaps. | **REJECTED** (`CID_CORRUPTION`) -> Routes to raster OCR. |
| `replacement_char_corrupted.pdf` | 1 | PDF emitting `\ufffd` characters from corrupted character encodings. | **REJECTED** (`UNICODE_REPLACEMENT`) -> Routes to raster OCR. |
| `legacy_krutidev.pdf` | 1 | PDF embedding `KrutiDev010` font family with 8-bit pseudo-Latin strings (`LFkku izfr...`). | **REJECTED** (`LEGACY_INDIC_FONT`) -> Routes to raster OCR. |
| `hybrid_mixed_pages.pdf` | 2 | Multi-page document with Page 1 clean English CBC and Page 2 legacy Indic prescription. | **Page 1: `pymupdf_direct`**, **Page 2: raster OCR**. |

Generated automatically by `scripts/generate_pdf_text_fixtures.py`.
