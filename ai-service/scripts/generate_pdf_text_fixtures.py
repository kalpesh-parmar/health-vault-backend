from __future__ import annotations

"""Generate reproducible synthetic PDF fixtures for text-layer sanitization testing."""

from pathlib import Path
import fitz


def generate_fixtures(output_dir: Path) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    generated_files: dict[str, Path] = {}

    # 1. clean_born_digital.pdf (2-page clean English lab report)
    doc_clean = fitz.open()
    # Page 1: Complete Blood Count
    p1 = doc_clean.new_page()
    p1_lines = [
        "METROPOLITAN CLINICAL LABORATORIES",
        "PATIENT REPORT: COMPLETE BLOOD COUNT (CBC)",
        "PATIENT NAME: JOHN DOE         AGE: 45 YRS     GENDER: MALE",
        "REF DR: DR. ROBERT SMITH MD    DATE: 2026-10-01",
        "-------------------------------------------------------------",
        "TEST INVESTIGATION            RESULT    UNIT        REFERENCE",
        "-------------------------------------------------------------",
        "HEMOGLOBIN                    14.5      g/dL        13.0 - 17.0",
        "TOTAL LEUKOCYTE COUNT (WBC)   7500      cells/cumm  4000 - 11000",
        "RED BLOOD CELLS (RBC)         4.8       mill/cumm   4.5 - 5.5",
        "PLATELET COUNT                250000    cells/cumm  150000 - 450000",
        "PACKED CELL VOLUME (PCV)      44.0      %           40.0 - 50.0",
        "MEAN CORPUSCULAR VOLUME (MCV) 88.0      fl          80.0 - 100.0",
        "MCH                           29.5      pg          27.0 - 32.0",
        "MCHC                          33.5      g/dL        32.0 - 36.0",
        "-------------------------------------------------------------",
        "REMARKS: CLINICALLY CORRELATED. NORMAL COMPLETE BLOOD COUNT.",
    ]
    y = 60
    for line in p1_lines:
        p1.insert_text((50, y), line, fontsize=10, fontname="helv")
        y += 18

    # Page 2: Liver Function Test
    p2 = doc_clean.new_page()
    p2_lines = [
        "METROPOLITAN CLINICAL LABORATORIES",
        "PATIENT REPORT: LIVER FUNCTION TEST (LFT)",
        "PATIENT NAME: JOHN DOE         AGE: 45 YRS     GENDER: MALE",
        "-------------------------------------------------------------",
        "TEST INVESTIGATION            RESULT    UNIT        REFERENCE",
        "-------------------------------------------------------------",
        "BILIRUBIN TOTAL               0.8       mg/dL       0.2 - 1.2",
        "BILIRUBIN DIRECT              0.2       mg/dL       0.0 - 0.3",
        "SGOT / AST                    32        U/L         10 - 40",
        "SGPT / ALT                    35        U/L         10 - 45",
        "ALKALINE PHOSPHATASE (ALP)    85        U/L         40 - 129",
        "TOTAL PROTEIN                 7.2       g/dL        6.0 - 8.3",
        "SERUM ALBUMIN                 4.4       g/dL        3.5 - 5.0",
        "-------------------------------------------------------------",
        "STATUS: NORMAL LIVER FUNCTION ENZYME PANEL",
        "AUTHORIZED BY: DR. EMILY WATSON MD, CONSULTANT PATHOLOGIST",
    ]
    y = 60
    for line in p2_lines:
        p2.insert_text((50, y), line, fontsize=10, fontname="helv")
        y += 18

    clean_path = output_dir / "clean_born_digital.pdf"
    doc_clean.save(str(clean_path))
    doc_clean.close()
    generated_files["clean_born_digital"] = clean_path

    # 2. cid_corrupted.pdf (1-page document with CID tokens)
    doc_cid = fitz.open()
    p_cid = doc_cid.new_page()
    cid_lines = [
        "CLINICAL PATHOLOGY LABORATORY SERVICES",
        "PATIENT REPORT (cid:10)(cid:24)(cid:55) INVESTIGATION (cid:82)(cid:91) (cid:112)",
        "RESULT VALUE: (cid:33)(cid:44)(cid:55) NORMAL RANGE (cid:66)(cid:77)",
        "SERUM GLUCOSE FASTING (cid:100)(cid:101) mg/dL (cid:102)(cid:103)",
        "DOCTOR SIGNATURE (cid:200)(cid:201)(cid:202) CONSULTANT",
    ]
    y = 80
    for line in cid_lines:
        p_cid.insert_text((50, y), line, fontsize=11, fontname="helv")
        y += 24

    cid_path = output_dir / "cid_corrupted.pdf"
    doc_cid.save(str(cid_path))
    doc_cid.close()
    generated_files["cid_corrupted"] = cid_path

    # 3. replacement_char_corrupted.pdf (1-page document with Unicode replacement chars)
    doc_repl = fitz.open()
    p_repl = doc_repl.new_page()
    helv_buf = fitz.Font("helv").buffer
    p_repl.insert_font(fontname="f0", fontbuffer=helv_buf)
    repl_lines = [
        "HOSPITAL LABORATORY SERVICES - INVESTIGATION REPORT",
        "PATIENT BIOCHEMISTRY ???? PANEL STATUS ??",
        "BLOOD UREA NITROGEN ???? 18 mg/dL ?? NORMAL",
        "SERUM CREATININE ???? 1.0 mg/dL ????",
        "VERIFIED BY PATHOLOGIST ?????? CLINICAL LAB",
    ]
    y = 80
    for line in repl_lines:
        p_repl.insert_text((50, y), line, fontsize=11, fontname="f0")
        y += 24

    for xref in p_repl.get_contents():
        stream_bytes = doc_repl.xref_stream(xref)
        if b"0020" in stream_bytes:
            new_stream = stream_bytes.replace(b"0020", b"FFFD")
            doc_repl.update_stream(xref, new_stream)

    repl_path = output_dir / "replacement_char_corrupted.pdf"
    doc_repl.save(str(repl_path))
    doc_repl.close()
    generated_files["replacement_char_corrupted"] = repl_path

    # 4. legacy_krutidev.pdf (1-page document with KrutiDev legacy font and pseudo-Latin text)
    doc_kruti = fitz.open()
    p_kruti = doc_kruti.new_page()
    helv_buf = fitz.Font("helv").buffer
    p_kruti.insert_font(fontname="KrutiDev010", fontbuffer=helv_buf)
    kruti_lines = [
        "LFkku izfr vLirky dzekad izi= vkns'k jksxh fooj.k fnukad MkWDVj",
        "izek.k i= fpfdRlk fooj.k nokbZ funsZ'k jksxh uke mez fyax",
        "izfrfnu nks xksyh lqcg 'kke [kkus ds ckn ysos",
        "MkWDVj lquhy 'kekZ fpfdRlk vf/kdkjh lfpoky; vLirky",
    ]
    y = 80
    for line in kruti_lines:
        p_kruti.insert_text((50, y), line, fontsize=11, fontname="KrutiDev010")
        y += 24

    kruti_path = output_dir / "legacy_krutidev.pdf"
    doc_kruti.save(str(kruti_path))
    doc_kruti.close()
    generated_files["legacy_krutidev"] = kruti_path

    # 5. hybrid_mixed_pages.pdf (Page 1 clean English + Page 2 legacy Indic KrutiDev)
    doc_hybrid = fitz.open()
    # Page 1: Clean English Lab Report
    h1 = doc_hybrid.new_page()
    y = 60
    for line in p1_lines:
        h1.insert_text((50, y), line, fontsize=10, fontname="helv")
        y += 18

    # Page 2: Legacy Indic KrutiDev Prescription
    h2 = doc_hybrid.new_page()
    h2.insert_font(fontname="KrutiDev010", fontbuffer=helv_buf)
    y = 80
    for line in kruti_lines:
        h2.insert_text((50, y), line, fontsize=11, fontname="KrutiDev010")
        y += 24

    hybrid_path = output_dir / "hybrid_mixed_pages.pdf"
    doc_hybrid.save(str(hybrid_path))
    doc_hybrid.close()
    generated_files["hybrid_mixed_pages"] = hybrid_path

    # 6. README.md explaining the test cases
    readme_path = output_dir / "README.md"
    readme_content = """# PDF Text Layer Test Cases

This directory contains synthetic, reproducible test PDF fixtures designed to validate the text-layer sanitization and per-page garble gate (`pdf_text.py` and `ocr_stage.py`):

| Fixture File | Pages | Description | Expected Gate Classification |
| :--- | :--- | :--- | :--- |
| `clean_born_digital.pdf` | 2 | Clean English CBC and LFT laboratory report with standard fonts and dense medical values. | **100% `pymupdf_direct`** (latency < 50ms per page, 0% OCR fallback). |
| `cid_corrupted.pdf` | 1 | Born-digital PDF with `(cid:...)` tokens resulting from missing ToUnicode CMaps. | **REJECTED** (`CID_CORRUPTION`) -> Routes to raster OCR. |
| `replacement_char_corrupted.pdf` | 1 | PDF emitting `\\ufffd` characters from corrupted character encodings. | **REJECTED** (`UNICODE_REPLACEMENT`) -> Routes to raster OCR. |
| `legacy_krutidev.pdf` | 1 | PDF embedding `KrutiDev010` font family with 8-bit pseudo-Latin strings (`LFkku izfr...`). | **REJECTED** (`LEGACY_INDIC_FONT`) -> Routes to raster OCR. |
| `hybrid_mixed_pages.pdf` | 2 | Multi-page document with Page 1 clean English CBC and Page 2 legacy Indic prescription. | **Page 1: `pymupdf_direct`**, **Page 2: raster OCR**. |

Generated automatically by `scripts/generate_pdf_text_fixtures.py`.
"""
    readme_path.write_text(readme_content, encoding="utf-8")
    generated_files["readme"] = readme_path

    return generated_files


if __name__ == "__main__":
    base_dir = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "pdf_text_cases"
    files = generate_fixtures(base_dir)
    print(f"Successfully generated {len(files)} fixture files in {base_dir}")
