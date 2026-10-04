import json
import os
from pathlib import Path
import pytest

FIXTURES_DIR = Path(os.environ.get("GOLDEN_SCANNED_DIR", str(Path(__file__).resolve().parent.parent / "fixtures" / "golden_scanned")))
LANGS = ["hi", "mr", "gu", "ta", "en"]

ALLOWED_STATUS = {"real_scanned", "synthetic_directional_only"}
ALLOWED_PROVENANCE = {"human_transcribed", "generated_source_text", "unverified_mined"}
ALLOWED_SPLITS = {"synthetic", "baseline_tuning", "held_out"}


def test_twenty_five_paired_json_files_exist():
    """Assert paired JSON ground truth files exist across languages, skipping gitignored real scans if absent."""
    # Synthetic languages must always exist
    synthetic_counts = {}
    for lang in ["hi", "mr", "ta"]:
        lang_dir = FIXTURES_DIR / lang
        assert lang_dir.exists() and lang_dir.is_dir(), f"Missing canonical synthetic directory: {lang_dir}"
        json_files = list(lang_dir.glob("*.json"))
        assert len(json_files) == 5, f"Expected 5 JSON files in synthetic {lang}, found {len(json_files)}"
        synthetic_counts[lang] = len(json_files)

    # Gujarati synthetic files (gu_02 through gu_05)
    gu_synthetic = [p for p in (FIXTURES_DIR / "gu").glob("*.json") if not p.name.startswith("gu_01")]
    assert len(gu_synthetic) == 4, f"Expected 4 synthetic Gujarati JSON files, found {len(gu_synthetic)}"
    synthetic_counts["gu_synthetic"] = len(gu_synthetic)

    # Real scan files (gitignored for PHI protection)
    en_dir = FIXTURES_DIR / "en"
    gu_01_path = FIXTURES_DIR / "gu" / "gu_01_quotation.json"
    has_real_scans = en_dir.exists() and len(list(en_dir.glob("*.json"))) == 5 and gu_01_path.exists()

    if not has_real_scans:
        pytest.skip(
            "Gitignored real patient scan fixtures (en/, gu/gu_01*) are absent in clean CI environment; "
            f"verified {sum(synthetic_counts.values())} synthetic JSON files (hi: 5, mr: 5, ta: 5, gu: 4)."
        )

    en_json = list(en_dir.glob("*.json"))
    assert len(en_json) == 5, f"Expected 5 JSON files in en, found {len(en_json)}"
    all_json = list(FIXTURES_DIR.glob("*/*.json"))
    assert len(all_json) == 25, f"Expected exactly 25 paired JSON files, found {len(all_json)}"


def test_schema_conformity():
    """Validate schema structure and permitted enum values for all present JSON files."""
    for lang in LANGS:
        lang_dir = FIXTURES_DIR / lang
        if not lang_dir.exists():
            continue
        for json_path in lang_dir.glob("*.json"):
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            # Required keys
            required_keys = {
                "docId", "language", "docType", "status", "provenance",
                "verified_by", "seen_in_v6_tuning", "split", "groundTruthText",
                "patientInfo", "medications", "labResults"
            }
            missing = required_keys - set(data.keys())
            assert not missing, f"{json_path.name} missing required keys: {missing}"

            # Validate enum types
            assert data["language"] in LANGS, f"Invalid language in {json_path.name}: {data['language']}"
            assert data["status"] in ALLOWED_STATUS, f"Invalid status in {json_path.name}: {data['status']}"
            assert data["provenance"] in ALLOWED_PROVENANCE, f"Invalid provenance in {json_path.name}: {data['provenance']}"
            assert data["split"] in ALLOWED_SPLITS, f"Invalid split in {json_path.name}: {data['split']}"
            assert isinstance(data["seen_in_v6_tuning"], bool), f"seen_in_v6_tuning must be bool in {json_path.name}"
            assert isinstance(data["patientInfo"], dict), f"patientInfo must be dict in {json_path.name}"
            assert isinstance(data["medications"], list), f"medications must be list in {json_path.name}"
            assert isinstance(data["labResults"], list), f"labResults must be list in {json_path.name}"


def test_synthetic_metadata_invariants():
    """Verify synthetic files are properly labeled with directional status and synthetic split."""
    for lang in ["hi", "mr", "ta"]:
        lang_dir = FIXTURES_DIR / lang
        for json_path in lang_dir.glob("*.json"):
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            assert data["status"] == "synthetic_directional_only"
            assert data["provenance"] == "generated_source_text"
            assert data["split"] == "synthetic"
            assert data["seen_in_v6_tuning"] is False
            assert len(data["groundTruthText"].strip()) > 0

    # Gujarati synthetic files (gu_02 through gu_05)
    for i in range(2, 6):
        json_path = FIXTURES_DIR / "gu" / f"gu_0{i}_prescription.json"
        if not json_path.exists():
            matches = list((FIXTURES_DIR / "gu").glob(f"gu_0{i}_*.json"))
            assert matches, f"Missing gu_0{i} JSON"
            json_path = matches[0]

        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        assert data["status"] == "synthetic_directional_only"
        assert data["provenance"] == "generated_source_text"
        assert data["split"] == "synthetic"
        assert data["seen_in_v6_tuning"] is False


def test_real_scan_templates_unannotated():
    """Verify all real scanned documents have human_transcribed provenance and are either unannotated templates or fully annotated."""
    en_dir = FIXTURES_DIR / "en"
    gu_01_path = FIXTURES_DIR / "gu" / "gu_01_quotation.json"

    real_paths = list(en_dir.glob("*.json")) if en_dir.exists() else []
    if gu_01_path.exists():
        real_paths.append(gu_01_path)

    if not real_paths:
        pytest.skip("Real patient scans (en/, gu/gu_01*) are absent in clean CI environment (gitignored for PHI protection)")

    assert len(real_paths) == 6, f"Expected 6 real scanned documents when present, found {len(real_paths)}"

    for json_path in real_paths:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        assert data["status"] == "real_scanned"
        assert data["provenance"] == "human_transcribed"
        assert data["split"] in ("baseline_tuning", "held_out")
        
        # Accepts either empty template OR fully annotated entry
        is_empty_template = (data.get("verified_by") is None and (data.get("groundTruthText") or "") == "")
        is_fully_annotated = (bool(data.get("verified_by")) and bool((data.get("groundTruthText") or "").strip()))
        
        assert is_empty_template or is_fully_annotated, (
            f"{json_path.name} must be either an unannotated template (verified_by=null, groundTruthText='') "
            f"or fully annotated (verified_by=<str>, non-empty groundTruthText)"
        )


def test_formal_gate_set_count():
    """Informational count of formal gate set (status == real_scanned AND split == held_out AND verified_by is set)."""
    gate_set = []
    for lang in LANGS:
        lang_dir = FIXTURES_DIR / lang
        if not lang_dir.exists():
            continue
        for json_path in lang_dir.glob("*.json"):
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if (
                data.get("status") == "real_scanned"
                and data.get("split") == "held_out"
                and data.get("verified_by") is not None
            ):
                gate_set.append(data["docId"])

    # Informational count of production-gated documents
    gate_count = len(gate_set)
    print(f"\n[INFO] Formal accuracy gate set count: {gate_count} (documents: {gate_set})")
    assert isinstance(gate_count, int) and gate_count >= 0

