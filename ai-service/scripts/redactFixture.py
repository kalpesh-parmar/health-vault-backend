#!/usr/bin/env python3
"""PyMuPDF fixture redaction script.

Redacts patient name, phone number, case ID, referring doctor, and watermark strings
from fixture PDFs while strictly preserving layout and word bounding box positions.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

try:
    import fitz
except ImportError:
    print("PyMuPDF (fitz) is required. Install with `pip install pymupdf`.", file=sys.stderr)
    sys.exit(1)


# Sensitive tokens to sanitize with exact or similar length synthetic tokens
SENSITIVE_TERM_REPLACEMENTS = [
    # Case ID / UHID
    ("5069200904", "0000000000"),
    # Doctor name tokens
    ("HARDIK", "DOCTOR"),
    ("SUVAGIYA", "NAME"),
    # Patient name tokens
    ("Manjulaben", "PatientName"),
    ("Ranoliya", "Anonymous"),
    ("Manjuben", "PatientN"),
    ("Manju", "Patient"),
]

# Watermark stream byte replacements
WATERMARK_BYTE_REPLACEMENTS = [
    (b"5069200904", b"0000000000"),
    (b"Manjulaben", b"PatientName"),
    (b"Ranoliya", b"Anonymous"),
    (b"Manjuben", b"PatientN"),
    (b"Manju", b"Patient"),
]

PHONE_PATTERN = re.compile(r"\b\d{10}\b")


def redact_pdf(src_path: Path | str, dst_path: Path | str) -> None:
    """Redact PHI and watermarks from PDF while keeping layout and text positions."""
    src = Path(src_path)
    dst = Path(dst_path)
    dst.parent.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(src)

    # 1. Redact watermark content streams
    for pno in range(len(doc)):
        page = doc[pno]
        for xref in page.get_contents():
            stream = doc.xref_stream(xref)
            if b"a3ec807f" in stream or b"5069200904" in stream or b"Manju" in stream:
                for old_bytes, new_bytes in WATERMARK_BYTE_REPLACEMENTS:
                    stream = stream.replace(old_bytes, new_bytes)
                doc.update_stream(xref, stream)

    # 2. Redact foreground header and annotations
    for page in doc:
        # Redact specific sensitive terms
        for term, replacement in SENSITIVE_TERM_REPLACEMENTS:
            rects = page.search_for(term)
            for r in rects:
                page.add_redact_annot(r, text=replacement, fill=(1, 1, 1))

        # Redact 10-digit phone numbers in header area (y < 280)
        words = page.get_text("words")
        for w in words:
            word_text = str(w[4])
            if PHONE_PATTERN.fullmatch(word_text) and float(w[1]) < 280:
                rect = fitz.Rect(float(w[0]), float(w[1]), float(w[2]), float(w[3]))
                page.add_redact_annot(rect, text="0000000000", fill=(1, 1, 1))

        page.apply_redactions()

    doc.save(str(dst))
    doc.close()


def verify_redacted_fixture(pdf_path: Path) -> dict[str, Any]:
    """Run extraction, status, and direct-text integration tests against the redacted PDF."""
    results: dict[str, Any] = {}

    from app.services.pipeline.ocr_stage import OcrStageHandler
    from app.services.pipeline.lab_evaluator import LabEvaluator
    from app.modules.file_processing.pdf_text import validate_page_direct_text
    from app.services.pipeline.spatial_row_builder import SpatialRowBuilder

    doc = fitz.open(pdf_path)
    results["page_count"] = len(doc)

    # Test 1: extract_spatial_parameters
    extracted = OcrStageHandler.extract_spatial_parameters(doc)
    results["spatial_parameters_count"] = len(extracted)
    results["spatial_parameters_pass"] = len(extracted) >= 31

    # Test 2: SpatialRowBuilder across all pages
    builder = SpatialRowBuilder()
    all_builder_params: list[dict[str, Any]] = []
    for pno, page in enumerate(doc):
        raw_words = page.get_text("words")
        w_dicts = [
            {"x0": w[0], "y0": w[1], "x1": w[2], "y1": w[3], "word": w[4]}
            for w in raw_words
        ]
        all_builder_params.extend(
            builder.extract_parameters_from_words(w_dicts, page_number=pno + 1)
        )
    results["spatial_row_builder_count"] = len(all_builder_params)
    results["spatial_row_builder_pass"] = len(all_builder_params) >= 31

    # Test 3: validate_page_direct_text across all pages
    all_texts = [p.get_text("text") for p in doc]
    direct_pass = True
    for idx, page in enumerate(doc):
        res = validate_page_direct_text(
            doc, idx + 1, all_texts[idx], doc_page_texts=all_texts
        )
        if not res.is_valid_direct_text:
            direct_pass = False
            break
    results["direct_text_validation_pass"] = direct_pass

    # Test 4: lab evaluator on extracted parameters
    evaluated = LabEvaluator.evaluate_all(extracted)
    results["evaluated_parameters_count"] = len(evaluated)
    results["evaluated_pass"] = len(evaluated) >= 31

    doc.close()
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Redact PHI from PDF fixtures.")
    parser.add_argument("--input", type=Path, help="Input PDF path")
    parser.add_argument("--output", type=Path, help="Output PDF path")
    parser.add_argument(
        "--test-fixtures",
        action="store_true",
        help="Produce redacted fixtures in a temporary folder and run test verification",
    )
    args = parser.parse_args()

    repo_fixtures = (
        Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "golden_docs"
    )

    if args.input and args.output:
        redact_pdf(args.input, args.output)
        print(f"Redacted {args.input} -> {args.output}")
        return

    if args.test_fixtures or (not args.input and not args.output):
        temp_dir = Path(tempfile.mkdtemp(prefix="health_vault_redacted_fixtures_"))
        print(f"Producing redacted fixtures in temporary directory (NOT in repo): {temp_dir}")

        targets = ["5069200904.pdf", "real_6page_digital.pdf"]
        for target_name in targets:
            src = repo_fixtures / target_name
            dst = temp_dir / target_name
            if not src.exists():
                print(f"Source fixture {src} not found, skipping.")
                continue

            print(f"Redacting {target_name}...")
            redact_pdf(src, dst)

            print(f"Verifying {target_name} against extraction and status pipeline...")
            res = verify_redacted_fixture(dst)
            print(f"Results for {target_name}:")
            for k, v in res.items():
                print(f"  {k}: {v}")

            assert res["spatial_parameters_pass"], "Spatial parameters count < 31"
            assert res["spatial_row_builder_pass"], "SpatialRowBuilder count < 31"
            assert res["direct_text_validation_pass"], "Direct text validation failed"
            assert res["evaluated_pass"], "Evaluated parameters count < 31"
            print(f"==> {target_name}: ALL TESTS PASSED.")

        print(f"\nAll fixtures successfully redacted and validated in temp directory: {temp_dir}")


if __name__ == "__main__":
    main()
