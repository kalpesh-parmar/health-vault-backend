from __future__ import annotations

import pytest

from app.api.v1.routes.extraction import MedicalGraphModel
from app.modules.extraction.prompts import graph_extraction_prompt, structured_document_prompt
from app.modules.extraction.service import normalize_graph_dict


def test_prompts_do_not_contain_schema_placeholder_strings():
    graph_msgs = graph_extraction_prompt({"fullText": "sample text"})
    user_content = graph_msgs[1]["content"]
    assert "number|null" not in user_content
    assert "string|null" not in user_content
    assert "[string|number, ...]" not in user_content

    doc_msgs = structured_document_prompt({"fullText": "sample text"})
    doc_content = doc_msgs[1]["content"]
    assert "number|null" not in doc_content
    assert "string|null" not in doc_content


def test_normalize_graph_dict_cleans_placeholder_strings():
    raw_leaked_graph = {
        "graphType": "line-chart|bar-chart|ecg|trend|other",
        "title": "string|null",
        "xAxis": ["string|number, ...", "2025-01-01", "2025-01-02"],
        "yAxis": ["number, ...", 120, 130],
        "series": [{"name": "string|null", "values": ["number, ...", 120, 130]}],
        "unit": "string|null",
        "page": "number|null",
        "metadata": "object",
    }

    normalized = normalize_graph_dict(raw_leaked_graph)

    assert normalized["page"] is None
    assert normalized["title"] is None
    assert normalized["unit"] is None
    assert normalized["graphType"] == "unknown"
    assert normalized["xAxis"] == ["2025-01-01", "2025-01-02"]
    assert normalized["yAxis"] == [120, 130]
    assert normalized["series"] == [{"name": "Series", "values": [120, 130]}]
    assert normalized["metadata"] == {}

    # Validate against Pydantic model
    validated = MedicalGraphModel(**normalized)
    assert validated.page is None
    assert validated.title is None
    assert validated.graphType == "unknown"


def test_normalize_graph_dict_preserves_valid_values():
    valid_graph = {
        "graphType": "trend",
        "title": "BP Measurement",
        "xAxis": ["Day 1", "Day 2"],
        "yAxis": [120, 115],
        "series": [{"name": "Systolic", "values": [120, 115]}],
        "unit": "mmHg",
        "page": 2,
        "metadata": {"source": "table_3"},
    }

    normalized = normalize_graph_dict(valid_graph)

    assert normalized["page"] == 2
    assert normalized["title"] == "BP Measurement"
    assert normalized["unit"] == "mmHg"
    assert normalized["graphType"] == "trend"
    assert normalized["xAxis"] == ["Day 1", "Day 2"]
    assert normalized["yAxis"] == [120, 115]
    assert normalized["series"] == [{"name": "Systolic", "values": [120, 115]}]
    assert normalized["metadata"] == {"source": "table_3"}

    validated = MedicalGraphModel(**normalized)
    assert validated.page == 2
    assert validated.title == "BP Measurement"


def test_normalize_graph_dict_coerces_numeric_string_page():
    graph_with_str_page = {
        "graphType": "bar-chart",
        "page": "3",
    }
    normalized = normalize_graph_dict(graph_with_str_page)
    assert normalized["page"] == 3

    validated = MedicalGraphModel(**normalized)
    assert validated.page == 3
