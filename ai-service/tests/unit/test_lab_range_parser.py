from __future__ import annotations

import pytest

from app.services.pipeline.lab_evaluator import LabRangeParser


class TestLabRangeParser:
    """Commit 3A: Unit tests for clinical reference range parser."""

    def test_numeric_ranges_hyphen(self):
        # 12 - 15
        r1 = LabRangeParser.parse_range("12 - 15")
        assert r1["low"] == 12.0
        assert r1["high"] == 15.0
        assert r1["operator"] == "-"
        assert r1["status"] == "parsed"

        # 3.8-4.8
        r2 = LabRangeParser.parse_range("3.8-4.8")
        assert r2["low"] == 3.8
        assert r2["high"] == 4.8
        assert r2["operator"] == "-"

        # 150000-410000
        r3 = LabRangeParser.parse_range("150000-410000")
        assert r3["low"] == 150000.0
        assert r3["high"] == 410000.0

        # 13.87-18.27
        r4 = LabRangeParser.parse_range("13.87-18.27")
        assert r4["low"] == 13.87
        assert r4["high"] == 18.27

        # Range with thousands comma separators: 150,000 - 450,000
        r5 = LabRangeParser.parse_range("150,000 - 450,000")
        assert r5["low"] == 150000.0
        assert r5["high"] == 450000.0

    def test_single_operator_ranges(self):
        # < 5.7
        r1 = LabRangeParser.parse_range("< 5.7")
        assert r1["operator"] == "<"
        assert r1["high"] == 5.7
        assert r1["low"] is None
        assert r1["status"] == "parsed"

        # <= 140.0
        r2 = LabRangeParser.parse_range("<= 140.0")
        assert r2["operator"] == "<="
        assert r2["high"] == 140.0
        assert r2["low"] is None

        # >= 6.5
        r3 = LabRangeParser.parse_range(">= 6.5")
        assert r3["operator"] == ">="
        assert r3["low"] == 6.5
        assert r3["high"] is None

        # > 200 : Provisional Diagnosis of Diabetes
        r4 = LabRangeParser.parse_range("> 200 : Provisional Diagnosis of Diabetes")
        assert r4["operator"] == ">"
        assert r4["low"] == 200.0
        assert r4["status"] == "parsed"

    def test_time_duration_ranges_and_conversion(self):
        # Up To 7 min.
        r1 = LabRangeParser.parse_range("Up To 7 min.")
        assert r1["is_time"] is True
        assert r1["operator"] == "<="
        assert r1["high"] == 420.0  # 7 * 60 seconds
        assert r1["status"] == "parsed"

        # Up to 9 min.
        r2 = LabRangeParser.parse_range("Up to 9 min.")
        assert r2["is_time"] is True
        assert r2["operator"] == "<="
        assert r2["high"] == 540.0  # 9 * 60 seconds

        # Time value conversion
        val_sec = LabRangeParser.parse_time_value_to_seconds("02 Min 15 Sec")
        assert val_sec == 135.0  # 2 * 60 + 15

        val_sec2 = LabRangeParser.parse_time_value_to_seconds("04 Min 30 Sec")
        assert val_sec2 == 270.0

        val_sec3 = LabRangeParser.parse_time_value_to_seconds("45 Sec")
        assert val_sec3 == 45.0

        # Non-time value returns None
        assert LabRangeParser.parse_time_value_to_seconds("11.20") is None

    def test_tiered_text_ranges(self):
        raw = "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic"
        parsed = LabRangeParser.parse_range(raw)
        assert parsed["operator"] == "tiered"
        assert len(parsed["tiers"]) == 3
        assert parsed["tiers"][0]["tier"] == "normal"
        assert parsed["tiers"][0]["high"] == 5.7
        assert parsed["tiers"][1]["tier"] == "prediabetic"
        assert parsed["tiers"][1]["low"] == 5.7
        assert parsed["tiers"][1]["high"] == 6.4
        assert parsed["tiers"][2]["tier"] == "diabetic"
        assert parsed["tiers"][2]["low"] == 6.5

    def test_unparseable_or_ambiguous_ranges(self):
        # Basophil absolute bare number: "100.0" without operator
        r1 = LabRangeParser.parse_range("100.0")
        assert r1["status"] == "no_range"
        assert r1["low"] is None
        assert r1["high"] is None
        assert r1["raw_text"] == "100.0"

        # Empty or non-range strings
        r2 = LabRangeParser.parse_range("")
        assert r2["status"] == "no_range"

        r3 = LabRangeParser.parse_range(None)
        assert r3["status"] == "no_range"

        r4 = LabRangeParser.parse_range("See clinical correlation")
        assert r4["status"] == "no_range"
        assert r4["raw_text"] == "See clinical correlation"

    def test_preserves_reference_raw_always(self):
        input_raw = "13.87 - 18.27 Sec"
        parsed = LabRangeParser.parse_range(input_raw)
        assert parsed["raw_text"] == input_raw
        assert parsed["status"] == "parsed"
