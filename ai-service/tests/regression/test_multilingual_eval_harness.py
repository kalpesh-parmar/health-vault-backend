import sys
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.eval_multilingual_ocr import (
    calculate_percentiles,
    compute_cer,
    compute_wer,
    discover_corpus,
)

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "golden_scanned"


def test_percentile_calculation_includes_n():
    """Verify calculate_percentiles accurately calculates p50/p95 and includes n."""
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    res = calculate_percentiles(values)
    assert res["n"] == 5
    assert res["p50"] == 30.0
    assert res["min"] == 10.0
    assert res["max"] == 50.0
    assert "p95" in res

    empty_res = calculate_percentiles([])
    assert empty_res["n"] == 0
    assert empty_res["p50"] == 0.0


def test_cer_wer_computation():
    """Verify character and word error rate computation."""
    ref = "डॉ. राजेश कुमार शर्मा"
    hyp = "डॉ. राजेश कुमार शर्मा"
    assert compute_cer(hyp, ref) == 0.0
    assert compute_wer(hyp, ref) == 0.0

    hyp_err = "डॉ राजेश शर्मा"
    assert compute_cer(hyp_err, ref) > 0.0
    assert compute_wer(hyp_err, ref) > 0.0


def test_corpus_discovery_and_provenance_gating():
    """Verify corpus discovery identifies 25 core documents with strict gating."""
    docs = discover_corpus(FIXTURES_DIR, include_ablation=False)
    assert len(docs) == 25, f"Expected 25 core documents, found {len(docs)}"

    # 19 synthetic directional documents
    synthetic_docs = [d for d in docs if d["gate"] == "SYNTHETIC_DIRECTIONAL"]
    assert len(synthetic_docs) == 19
    for d in synthetic_docs:
        assert d["is_annotated"] is True
        assert d["split"] == "synthetic"
        assert d["status"] == "synthetic_directional_only"

    # 6 unannotated real scanned templates
    real_templates = [d for d in docs if d["gate"] == "UNANNOTATED_TEMPLATE"]
    assert len(real_templates) == 6
    for d in real_templates:
        assert d["is_annotated"] is False
        assert d["split"] == "baseline_tuning"
        assert d["status"] == "real_scanned"
        assert d["verified_by"] is None


def test_ablation_fixtures_isolated():
    """Verify ablation fixtures are isolated and not included in core 25-page set."""
    core_docs = discover_corpus(FIXTURES_DIR, include_ablation=False)
    assert not any(d["is_ablation"] for d in core_docs)

    all_docs = discover_corpus(FIXTURES_DIR, include_ablation=True)
    ablation_docs = [d for d in all_docs if d["is_ablation"]]
    assert len(ablation_docs) == 4
    for d in ablation_docs:
        assert d["gate"] == "ABLATION"
