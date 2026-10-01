from __future__ import annotations

import logging
import re
import time
from typing import Any

logger = logging.getLogger(__name__)

# Section header patterns common in Indian and global medical documents
KNOWN_SECTION_PATTERNS = [
    (r"\b(CHIEF COMPLAINTS?|COMPLAINTS?|PRESENTING COMPLAINTS?)\b", "CHIEF_COMPLAINTS"),
    (r"\b(HISTORY OF PRESENT ILLNESS|H/O PRESENT ILLNESS|PAST MEDICAL HISTORY|PAST HISTORY)\b", "CLINICAL_HISTORY"),
    (r"\b(PHYSICAL EXAMINATION|ON EXAMINATION|O/E|GENERAL EXAMINATION|SYSTEMIC EXAMINATION)\b", "EXAMINATION"),
    (r"\b(VITAL SIGNS?|VITALS)\b", "VITALS"),
    (r"\b(LABORATORY INVESTIGATIONS?|INVESTIGATIONS?|LAB REPORTS?|TEST RESULTS?|PATHOLOGY REPORT)\b", "INVESTIGATIONS"),
    (r"\b(DIAGNOSIS|PROVISIONAL DIAGNOSIS|FINAL DIAGNOSIS|IMPRESSION|ASSESSMENT)\b", "DIAGNOSIS"),
    (r"\b(MEDICATIONS?|PRESCRIPTION|RX|TREATMENT GIVEN|DRUGS PRESCRIBED)\b", "MEDICATIONS"),
    (r"\b(ADVICE|RECOMMENDATIONS?|PLAN OF CARE|DISCHARGE INSTRUCTIONS?|FOLLOW UP|NEXT VISIT)\b", "ADVICE"),
]

NOISE_AD_PATTERNS = [
    r"(?i)\b(advertisement|sponsored|flat \d+% off|call us for home collection|franchise enquiry)\b",
    r"(?i)\b(download our app on playstore|book appointment online at www\.)\b",
]

HEADER_LETTERHEAD_PATTERNS = [
    r"(?i)\b(iso \d{4,5}:\d{4} certified|nabh accredited|nabl accredited laboratory|regd\. no\.)\b",
]

# Patterns for detecting table headers in medical documents
TABLE_HEADER_PATTERNS = [
    r"(?i)\b(test|investigation|parameter|analyte|test\s+name|result|observed|value|unit|units|range|reference|ref\.?\s*range|interval|normal|biological|flag|specimen|method)\b",
    r"(?i)\b(medicine|medication|drug|rx|tablet|capsule|dose|dosage|duration|days|times|frequency|qty|quantity|instruction|instructions|timing|type|sr|s\.?no|s/n)\b",
    r"(?i)\b(description|particulars|amount|rate|charges|cost)\b",
]


class LayoutStageHandler:
    """Parses raw OCR pages into a structured layout hierarchy:
    spatial bounding-box clustering, table reconstruction, reading order,
    section headers, signatures, and noise filters.
    """

    def __init__(self, row_vertical_tolerance: float = 0.65) -> None:
        self.row_vertical_tolerance = row_vertical_tolerance

    @staticmethod
    def _normalize_bounding_box(box_raw: Any) -> dict[str, float] | None:
        """Normalize polygon quad or 2-point/4-point rectangle into canonical coordinates.

        Supported inputs:
        - 4-point polygon: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] (list, tuple, numpy array)
        - 4-element sequence: [x1, y1, x2, y2]
        - 2-point sequence: [[x1, y1], [x2, y2]]

        Returns:
            dict with: x1, y1, x2, y2, cx, cy, width, height, or None if invalid.
        """
        if box_raw is None:
            return None
        try:
            if hasattr(box_raw, "tolist"):
                box_raw = box_raw.tolist()
            if not isinstance(box_raw, (list, tuple)) or len(box_raw) == 0:
                return None

            first = box_raw[0]
            if isinstance(first, (list, tuple)):
                if len(box_raw) >= 4:
                    xs = [float(p[0]) for p in box_raw]
                    ys = [float(p[1]) for p in box_raw]
                    x1, x2 = min(xs), max(xs)
                    y1, y2 = min(ys), max(ys)
                elif len(box_raw) == 2:
                    p1, p2 = box_raw[0], box_raw[1]
                    x1, x2 = min(float(p1[0]), float(p2[0])), max(float(p1[0]), float(p2[0]))
                    y1, y2 = min(float(p1[1]), float(p2[1])), max(float(p1[1]), float(p2[1]))
                else:
                    return None
            elif len(box_raw) == 4:
                x1 = min(float(box_raw[0]), float(box_raw[2]))
                x2 = max(float(box_raw[0]), float(box_raw[2]))
                y1 = min(float(box_raw[1]), float(box_raw[3]))
                y2 = max(float(box_raw[1]), float(box_raw[3]))
            else:
                return None

            width = max(0.0, x2 - x1)
            height = max(0.0, y2 - y1)
            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0

            return {
                "x1": round(x1, 2),
                "y1": round(y1, 2),
                "x2": round(x2, 2),
                "y2": round(y2, 2),
                "cx": round(cx, 2),
                "cy": round(cy, 2),
                "width": round(width, 2),
                "height": round(height, 2),
            }
        except Exception:
            return None

    def _cluster_spatial_rows(
        self,
        items: list[dict[str, Any]],
        tolerance: float | None = None,
    ) -> list[dict[str, Any]]:
        """Clusters spatial OCR items into visual horizontal rows using vertical proximity.

        Lightweight deterministic O(n log n) sweep-line clustering suitable for medical pages.
        """
        if not items:
            return []

        row_tol = tolerance if tolerance is not None else self.row_vertical_tolerance

        # 1. Sort items top-to-bottom by vertical center cy, then by x1
        sorted_items = sorted(items, key=lambda it: (it["box"]["cy"], it["box"]["x1"]))
        clusters: list[list[dict[str, Any]]] = []

        for item in sorted_items:
            box = item["box"]
            item_cy = box["cy"]
            item_h = max(box["height"], 1.0)
            placed = False

            # Check from most recent cluster backwards
            for cluster in reversed(clusters):
                cluster_cy = sum(b["box"]["cy"] for b in cluster) / len(cluster)
                cluster_h = sum(b["box"]["height"] for b in cluster) / len(cluster)
                ref_h = max(cluster_h, item_h, 1.0)

                cluster_y1 = min(b["box"]["y1"] for b in cluster)
                cluster_y2 = max(b["box"]["y2"] for b in cluster)

                vertical_dist = abs(item_cy - cluster_cy)
                is_vertically_aligned = vertical_dist <= (ref_h * row_tol)
                has_vertical_overlap = not (box["y2"] < cluster_y1 or box["y1"] > cluster_y2)

                if is_vertically_aligned and has_vertical_overlap:
                    cluster.append(item)
                    placed = True
                    break

            if not placed:
                clusters.append([item])

        # 2. Sort items within each row left-to-right (by x1)
        visual_rows: list[dict[str, Any]] = []
        for cluster in clusters:
            cluster.sort(key=lambda it: it["box"]["x1"])
            row_y1 = min(it["box"]["y1"] for it in cluster)
            row_y2 = max(it["box"]["y2"] for it in cluster)
            row_cy = sum(it["box"]["cy"] for it in cluster) / len(cluster)
            row_h = sum(it["box"]["height"] for it in cluster) / len(cluster)
            row_text = "  ".join(it["text"] for it in cluster if it["text"])

            visual_rows.append({
                "items": cluster,
                "y1": row_y1,
                "y2": row_y2,
                "cy": row_cy,
                "height": row_h,
                "text": row_text,
            })

        visual_rows.sort(key=lambda r: r["cy"])
        return visual_rows

    def _is_table_header_row(self, row: dict[str, Any]) -> bool:
        """Determines if a visual row represents a candidate table header."""
        items = row.get("items") or []
        if len(items) < 2:
            return False
        text = row.get("text", "")
        matches = 0
        for pat in TABLE_HEADER_PATTERNS:
            found = re.findall(pat, text)
            matches += len(found)
        return matches >= 2 or (
            len(items) >= 2
            and matches >= 1
            and any(
                w in text.lower()
                for w in ("medicine", "dose", "result", "test", "investigation", "parameter", "unit", "range")
            )
        )

    def _extract_tables_from_spatial_rows(
        self, visual_rows: list[dict[str, Any]], page_num: int
    ) -> list[dict[str, Any]]:
        """Reconstructs borderless and bordered tables from clustered spatial rows."""
        tables: list[dict[str, Any]] = []
        i = 0
        n = len(visual_rows)

        while i < n:
            row = visual_rows[i]
            if self._is_table_header_row(row):
                header_row = row
                header_items = header_row["items"]
                headers = [it["text"].strip() for it in header_items]
                col_spans = [(it["box"]["x1"], it["box"]["x2"]) for it in header_items]

                data_rows: list[list[str]] = []
                raw_data_rows: list[list[dict[str, Any]]] = []
                all_table_items = list(header_items)

                prev_row_y2 = header_row["y2"]
                prev_row_h = header_row["height"]

                j = i + 1
                while j < n:
                    curr_row = visual_rows[j]
                    curr_items = curr_row["items"]
                    curr_text = curr_row["text"]

                    # Stop condition 1: Large vertical gap indicating end of table
                    vertical_gap = curr_row["y1"] - prev_row_y2
                    max_expected_gap = max(prev_row_h, curr_row["height"]) * 2.5
                    if vertical_gap > max_expected_gap:
                        break

                    # Stop condition 2: Major section headers or physician signatures
                    if re.search(
                        r"(?i)\b(doctor'?s? signature|physician signature|authorized signatory|dr\.\s+[a-zA-Z\s]+md)\b",
                        curr_text,
                    ):
                        break
                    if (
                        any(re.search(pat, curr_text, re.IGNORECASE) for pat, _ in KNOWN_SECTION_PATTERNS)
                        and len(curr_text) < 50
                    ):
                        break

                    # Stop condition 3: Row must fall within table horizontal span
                    table_x1 = min(s[0] for s in col_spans) - 25
                    table_x2 = max(s[1] for s in col_spans) + 25
                    row_in_span = any(
                        it["box"]["x1"] >= table_x1 and it["box"]["x2"] <= table_x2 for it in curr_items
                    )
                    if not row_in_span:
                        break

                    # Map data row items to header columns
                    aligned_cells: list[list[str]] = [[] for _ in col_spans]
                    for it in curr_items:
                        it_cx = it["box"]["cx"]
                        best_col = 0
                        best_dist = float("inf")
                        for col_idx, (cx1, cx2) in enumerate(col_spans):
                            if cx1 - 20 <= it_cx <= cx2 + 20:
                                best_col = col_idx
                                best_dist = 0
                                break
                            dist = min(abs(it_cx - cx1), abs(it_cx - cx2))
                            if dist < best_dist:
                                best_dist = dist
                                best_col = col_idx
                        aligned_cells[best_col].append(it["text"].strip())

                    row_cells = [" ".join(c).strip() for c in aligned_cells]

                    # Valid data row has content and either >= 2 items or tabular values
                    if any(row_cells) and (len(curr_items) >= 2 or any(re.search(r"\d", c) for c in row_cells)):
                        data_rows.append(row_cells)
                        raw_data_rows.append(curr_items)
                        all_table_items.extend(curr_items)
                        prev_row_y2 = curr_row["y2"]
                        prev_row_h = curr_row["height"]
                        j += 1
                    else:
                        break

                if len(data_rows) >= 1:
                    confidences = [
                        float(it.get("confidence", 0.95))
                        for it in all_table_items
                        if it.get("confidence") is not None
                    ]
                    table_mean_conf = round(sum(confidences) / len(confidences), 4) if confidences else 0.95

                    tables.append({
                        "page": page_num,
                        "headers": headers,
                        "rows": data_rows,
                        "rowCount": len(data_rows),
                        "colCount": len(headers),
                        "confidence": table_mean_conf,
                        "provenance": {
                            "header_items": [
                                {"text": h["text"], "box": h["box"], "confidence": h.get("confidence", 1.0)}
                                for h in header_items
                            ],
                            "raw_rows": [
                                [
                                    {"text": it["text"], "box": it["box"], "confidence": it.get("confidence", 1.0)}
                                    for it in r
                                ]
                                for r in raw_data_rows
                            ],
                        },
                    })
                    i = j
                    continue
            i += 1

        return tables

    def parse_layout(self, raw_ocr_data: dict[str, Any]) -> dict[str, Any]:
        """Parses raw OCR pages into a structured layout hierarchy:
        spatial clustering, tables, reading order, section headers, signatures, and noise filters.
        """
        t0_total = time.perf_counter()
        logger.info("Decomposing document layout and tables...")
        pages = raw_ocr_data.get("pages") or []
        full_text = raw_ocr_data.get("fullText") or ""

        parsed_sections: list[dict[str, Any]] = []
        parsed_tables: list[dict[str, Any]] = []
        parsed_paragraphs: list[dict[str, Any]] = []
        parsed_signatures: list[dict[str, Any]] = []
        parsed_marginal_notes: list[dict[str, Any]] = []

        cleaned_text_lines: list[str] = []
        current_section_title = "GENERAL"
        current_section_lines: list[str] = []
        order_idx = 0

        # Telemetry accumulator spans
        spatial_cluster_ms = 0.0
        table_extraction_ms = 0.0
        column_reorder_ms = 0.0
        section_classification_ms = 0.0

        total_raw_lines = 0
        total_visual_lines = 0
        has_spatial_boxes = False

        for page_data in pages:
            page_num = page_data.get("page", 1)
            page_text = page_data.get("text", "")
            raw_lines = page_data.get("lines") or []
            total_raw_lines += len(raw_lines)

            # Check if spatial lines with bounding boxes are available
            spatial_items: list[dict[str, Any]] = []
            for item in raw_lines:
                if isinstance(item, dict):
                    box = item.get("box") or item.get("points")
                    text = (item.get("text") or "").strip()
                    conf = float(item.get("confidence") or item.get("score") or 1.0)
                    if box is not None and text:
                        norm_box = self._normalize_bounding_box(box)
                        if norm_box is not None:
                            spatial_items.append({
                                "text": text,
                                "confidence": conf,
                                "box": norm_box,
                                "raw_box": box,
                            })

            page_has_spatial = len(spatial_items) > 0
            if page_has_spatial:
                has_spatial_boxes = True

            # ── Spatial Path ──────────────────────────────────────────────────
            if page_has_spatial:
                t0_cluster = time.perf_counter()
                visual_rows = self._cluster_spatial_rows(spatial_items)
                spatial_cluster_ms += (time.perf_counter() - t0_cluster) * 1000
                total_visual_lines += len(visual_rows)

                t0_table = time.perf_counter()
                page_tables = self._extract_tables_from_spatial_rows(visual_rows, page_num)
                # If spatial table extraction found nothing, check bordered table lines as fallback
                if not page_tables:
                    line_strs = [r["text"] for r in visual_rows]
                    page_tables = self._extract_tables_from_lines(line_strs, page_num)
                table_extraction_ms += (time.perf_counter() - t0_table) * 1000
                parsed_tables.extend(page_tables)

                # Reordered lines from spatial visual rows
                reordered_lines = [r["text"] for r in visual_rows]

            # ── Text-Only Fallback Path ───────────────────────────────────────
            else:
                lines = page_text.splitlines()
                total_visual_lines += len(lines)

                t0_table = time.perf_counter()
                page_tables = self._extract_tables_from_lines(lines, page_num)
                table_extraction_ms += (time.perf_counter() - t0_table) * 1000
                parsed_tables.extend(page_tables)

                t0_reorder = time.perf_counter()
                reordered_lines = self._reorder_multi_column_lines(lines)
                column_reorder_ms += (time.perf_counter() - t0_reorder) * 1000

            # ── Section Classification & Paragraph Assembly ───────────────────
            t0_sec = time.perf_counter()
            for raw_line in reordered_lines:
                line = raw_line.strip()
                if not line:
                    continue

                # Noise Gate: skip pure commercial ad lines
                if any(re.search(pat, line) for pat in NOISE_AD_PATTERNS):
                    logger.debug("Filtered advertisement noise: length=%d", len(line))
                    continue

                # Check for physician signature lines
                if re.search(
                    r"(?i)\b(doctor'?s? signature|physician signature|authorized signatory|dr\.\s+[a-zA-Z\s]+md|mbbs)\b",
                    line,
                ):
                    parsed_signatures.append({"text": line, "page": page_num, "order": order_idx})
                    continue

                # Check for marginal / handwritten notes (e.g. asterisks, indented notations)
                if line.startswith(("*", "#", "NB:", "Note:", "P.T.O.", "Advised:")):
                    parsed_marginal_notes.append({"text": line, "page": page_num, "order": order_idx})

                # Check for section header
                matched_header = None
                for pat, header_type in KNOWN_SECTION_PATTERNS:
                    if re.search(pat, line, re.IGNORECASE) and len(line) < 60:
                        matched_header = header_type
                        break

                if matched_header:
                    if current_section_lines:
                        parsed_sections.append(
                            {
                                "title": current_section_title,
                                "content": "\n".join(current_section_lines),
                                "order": len(parsed_sections),
                            }
                        )
                        current_section_lines = []
                    current_section_title = matched_header
                else:
                    current_section_lines.append(line)
                    cleaned_text_lines.append(line)
                    parsed_paragraphs.append(
                        {
                            "text": line,
                            "label": "paragraph",
                            "section": current_section_title,
                            "page": page_num,
                            "order": order_idx,
                        }
                    )
                    order_idx += 1

            section_classification_ms += (time.perf_counter() - t0_sec) * 1000

        if current_section_lines:
            parsed_sections.append(
                {
                    "title": current_section_title,
                    "content": "\n".join(current_section_lines),
                    "order": len(parsed_sections),
                }
            )

        cleaned_text = "\n".join(cleaned_text_lines).strip()
        if not cleaned_text and full_text:
            cleaned_text = full_text

        layout_total_ms = (time.perf_counter() - t0_total) * 1000

        metrics = {
            "layout_total_ms": round(layout_total_ms, 3),
            "spatial_cluster_ms": round(spatial_cluster_ms, 3),
            "table_extraction_ms": round(table_extraction_ms, 3),
            "column_reorder_ms": round(column_reorder_ms, 3),
            "section_classification_ms": round(section_classification_ms, 3),
            "page_count": len(pages),
            "raw_line_count": total_raw_lines,
            "visual_line_count": total_visual_lines,
            "table_count": len(parsed_tables),
            "table_row_count": sum(t.get("rowCount", 0) for t in parsed_tables),
            "section_count": len(parsed_sections),
            "has_spatial_boxes": has_spatial_boxes,
        }

        logger.info(
            "Layout decomposition completed: sections=%d, tables=%d, paragraphs=%d (total=%.2f ms, tables=%.2f ms, spatial=%s)",
            len(parsed_sections),
            len(parsed_tables),
            len(parsed_paragraphs),
            layout_total_ms,
            table_extraction_ms,
            has_spatial_boxes,
        )

        return {
            "sections": parsed_sections,
            "tables": parsed_tables,
            "paragraphs": parsed_paragraphs,
            "signatures": parsed_signatures,
            "marginalNotes": parsed_marginal_notes,
            "cleanedText": cleaned_text,
            "metrics": metrics,
        }

    def _reorder_multi_column_lines(self, lines: list[str]) -> list[str]:
        """Preserves reading order for multi-column text structures."""
        reordered = []
        left_col = []
        right_col = []
        in_column_block = False

        for line in lines:
            parts = re.split(r"\s{4,}|\t|\|", line.strip())
            if len(parts) == 2 and all(len(p.strip()) > 3 for p in parts):
                in_column_block = True
                left_col.append(parts[0].strip())
                right_col.append(parts[1].strip())
            else:
                if in_column_block:
                    reordered.extend(left_col)
                    reordered.extend(right_col)
                    left_col = []
                    right_col = []
                    in_column_block = False
                reordered.append(line)

        if in_column_block:
            reordered.extend(left_col)
            reordered.extend(right_col)

        return reordered

    def _extract_tables_from_lines(self, lines: list[str], page_num: int) -> list[dict[str, Any]]:
        """Extracts bordered grid tables and borderless whitespace tables into matrices."""
        tables: list[dict[str, Any]] = []
        current_table_rows: list[list[str]] = []

        for line in lines:
            line_str = line.strip()
            # 1. Bordered table row (| cell | cell |)
            if line_str.startswith("|") and line_str.endswith("|"):
                cells = [c.strip() for c in line_str.split("|")[1:-1]]
                if any(c for c in cells):
                    # Skip markdown divider rows like |---|---|
                    if not all(re.match(r"^-+$", c) for c in cells):
                        current_table_rows.append(cells)
                continue

            # 2. Borderless whitespace table row (multi-column lab rows: test, value, unit, ref)
            cols = [col.strip() for col in re.split(r"\s{2,}|\t", line_str) if col.strip()]
            is_table_header = len(cols) >= 3 and any(
                w in line_str.lower()
                for w in (
                    "test",
                    "investigation",
                    "parameter",
                    "result",
                    "unit",
                    "range",
                    "reference",
                    "interval",
                    "normal",
                )
            )
            is_table_row = len(cols) >= 3 and any(re.search(r"\d", c) for c in cols)

            if is_table_header:
                if len(current_table_rows) >= 2:
                    headers = current_table_rows[0]
                    rows = current_table_rows[1:]
                    tables.append(
                        {
                            "page": page_num,
                            "headers": headers,
                            "rows": rows,
                            "rowCount": len(rows),
                            "colCount": len(headers),
                        }
                    )
                current_table_rows = [cols]
            elif is_table_row and current_table_rows:
                current_table_rows.append(cols)
            elif is_table_row and not current_table_rows:
                current_table_rows = [cols]
            else:
                if len(current_table_rows) >= 2:
                    headers = current_table_rows[0]
                    rows = current_table_rows[1:]
                    tables.append(
                        {
                            "page": page_num,
                            "headers": headers,
                            "rows": rows,
                            "rowCount": len(rows),
                            "colCount": len(headers),
                        }
                    )
                current_table_rows = []

        if len(current_table_rows) >= 2:
            headers = current_table_rows[0]
            rows = current_table_rows[1:]
            tables.append(
                {
                    "page": page_num,
                    "headers": headers,
                    "rows": rows,
                    "rowCount": len(rows),
                    "colCount": len(headers),
                }
            )

        return tables
