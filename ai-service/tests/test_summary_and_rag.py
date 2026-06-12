from __future__ import annotations

from app.modules.rag.service import rerank_chunks
from app.modules.summary.service import split_text


def test_summary_chunking_keeps_medical_values_near_boundaries() -> None:
    text = "\n".join(
        [
            "Patient DUMMY",
            "Glucose fasting 92 mg/dL",
            "HbA1c 5.6 %",
            "Vitamin D 18 ng/mL",
            "Follow up after 2 weeks",
        ]
    )
    chunks = split_text(text, max_chars=40)
    joined = "\n".join(chunks)
    assert "92 mg/dL" in joined
    assert "5.6 %" in joined
    assert "18 ng/mL" in joined


def test_rerank_boosts_lexically_matching_medical_chunk() -> None:
    chunks = [
        {"content": "General appointment note", "distance": 0.1, "chunk_id": "a"},
        {"content": "HbA1c result is 5.6 percent", "distance": 0.4, "chunk_id": "b"},
    ]
    ranked = rerank_chunks("What is my HbA1c result?", chunks, limit=2)
    assert ranked[0]["chunk_id"] == "b"
