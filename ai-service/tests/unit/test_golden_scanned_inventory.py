import hashlib
import json
from pathlib import Path
import pytest
from PIL import Image
try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

import os
FIXTURES_DIR = Path(os.environ.get("GOLDEN_SCANNED_DIR", str(Path(__file__).resolve().parent.parent / "fixtures" / "golden_scanned")))
MANIFEST_PATH = FIXTURES_DIR / "manifest.json"
CANONICAL_LANGS = ["hi", "mr", "gu", "ta", "en", "ablation"]
DOC_EXTENSIONS = {".jpg", ".jpeg", ".png", ".pdf", ".tif", ".tiff"}


def test_canonical_directories_exist():
    """Verify all canonical golden_scanned subdirectories exist (or skip en if gitignored and not present)."""
    assert FIXTURES_DIR.exists(), f"Fixtures dir missing: {FIXTURES_DIR}"
    for lang in CANONICAL_LANGS:
        lang_dir = FIXTURES_DIR / lang
        if lang == "en" and not lang_dir.exists():
            continue  # gitignored real-scan directory not checked out
        assert lang_dir.exists() and lang_dir.is_dir(), f"Missing canonical directory: {lang_dir}"


def test_manifest_synchronization():
    """Verify manifest.json exists and all tracked files match SHA-256 and size.
    Skips missing real scan files when the gitignored fixtures are not checked out.
    """
    assert MANIFEST_PATH.exists(), f"Manifest missing: {MANIFEST_PATH}"
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    assert isinstance(manifest, dict), "Manifest must be a JSON object"
    assert len(manifest) > 0, "Manifest must not be empty"

    skipped_real_scans = 0
    verified_count = 0

    for filename, meta in manifest.items():
        is_gitignored_real = filename.startswith("en_") or filename.startswith("gu_01")
        # Path in manifest may be relative to workspace or filename
        rel_path = meta.get("path")
        expected_sha = meta.get("sha256")
        expected_size = meta.get("size_bytes")

        # Resolve path
        file_path = None
        if rel_path:
            candidate = Path(rel_path)
            if candidate.is_absolute() and candidate.exists():
                file_path = candidate
            else:
                # Relative to repo root or fixtures dir
                candidate_repo = FIXTURES_DIR.parent.parent.parent / rel_path
                if candidate_repo.exists():
                    file_path = candidate_repo

        if file_path is None:
            # Fall back to finding filename under fixtures
            matches = list(FIXTURES_DIR.rglob(filename))
            if matches:
                file_path = matches[0]

        if file_path is None or not file_path.exists():
            if is_gitignored_real:
                skipped_real_scans += 1
                continue
            assert False, f"File {filename} in manifest not found on disk"

        with open(file_path, "rb") as f:
            content = f.read()
            computed_sha = hashlib.sha256(content).hexdigest()
            computed_size = len(content)

        assert computed_sha == expected_sha, f"Hash mismatch for {filename}: {computed_sha} != {expected_sha}"
        assert computed_size == expected_size, f"Size mismatch for {filename}: {computed_size} != {expected_size}"
        verified_count += 1


def test_sha256_deduplication():
    """Verify no two document files in golden_scanned have identical SHA-256 hashes."""
    hashes = {}
    for file_path in FIXTURES_DIR.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() in DOC_EXTENSIONS:
            with open(file_path, "rb") as f:
                sha = hashlib.sha256(f.read()).hexdigest()
            assert sha not in hashes, (
                f"Duplicate document detected! {file_path.name} and {hashes[sha].name} share hash {sha}"
            )
            hashes[sha] = file_path


def test_document_validity():
    """Verify every document file can be opened by PIL or fitz without corruption."""
    doc_count = 0
    for file_path in FIXTURES_DIR.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() in DOC_EXTENSIONS:
            doc_count += 1
            if file_path.suffix.lower() == ".pdf":
                assert fitz is not None, "fitz (PyMuPDF) required to validate PDF files"
                doc = fitz.open(file_path)
                assert len(doc) > 0, f"PDF {file_path.name} has 0 pages"
                page = doc.load_page(0)
                pix = page.get_pixmap()
                assert pix.width > 0 and pix.height > 0
                doc.close()
            else:
                with Image.open(file_path) as img:
                    img.verify()
                # Reopen to check dimensions (verify() closes/invalidates the stream)
                with Image.open(file_path) as img:
                    assert img.width > 0 and img.height > 0

    assert doc_count >= 6, f"Expected at least 6 initial scanned documents, found {doc_count}"
