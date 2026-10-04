import re
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))


def normalize_bounding_box(box_raw: Any) -> dict[str, float] | None:
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


def cluster_spatial_rows(
    items: list[dict[str, Any]],
    tolerance: float = 0.65,
) -> list[dict[str, Any]]:
    if not items:
        return []

    sorted_items = sorted(items, key=lambda it: (it["box"]["cy"], it["box"]["x1"]))
    clusters: list[list[dict[str, Any]]] = []

    for item in sorted_items:
        box = item["box"]
        item_cy = box["cy"]
        item_h = max(box["height"], 1.0)
        placed = False

        for cluster in reversed(clusters):
            cluster_cy = sum(b["box"]["cy"] for b in cluster) / len(cluster)
            cluster_h = sum(b["box"]["height"] for b in cluster) / len(cluster)
            ref_h = max(cluster_h, item_h, 1.0)

            cluster_y1 = min(b["box"]["y1"] for b in cluster)
            cluster_y2 = max(b["box"]["y2"] for b in cluster)

            vertical_dist = abs(item_cy - cluster_cy)
            is_vertically_aligned = vertical_dist <= (ref_h * tolerance)
            has_vertical_overlap = not (box["y2"] < cluster_y1 or box["y1"] > cluster_y2)

            if is_vertically_aligned and has_vertical_overlap:
                cluster.append(item)
                placed = True
                break

        if not placed:
            clusters.append([item])

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


TABLE_HEADER_PATTERNS = [
    r"(?i)\b(test|investigation|parameter|analyte|test\s+name|result|observed|value|unit|units|range|reference|ref\.?\s*range|interval|normal|biological|flag|specimen)\b",
    r"(?i)\b(medicine|medication|drug|rx|tablet|capsule|dose|dosage|duration|days|times|frequency|qty|quantity|instruction|instructions|timing|type|sr|s\.?no|s/n)\b",
    r"(?i)\b(description|particulars|amount|rate|charges|cost)\b",
]


def is_table_header_row(row: dict[str, Any]) -> bool:
    items = row.get("items") or []
    if len(items) < 2:
        return False
    text = row.get("text", "")
    matches = 0
    for pat in TABLE_HEADER_PATTERNS:
        found = re.findall(pat, text)
        matches += len(found)
    return matches >= 2 or (len(items) >= 2 and matches >= 1 and any(w in text.lower() for w in ("medicine", "dose", "result", "test", "investigation")))


def extract_tables_from_spatial_rows(visual_rows: list[dict[str, Any]], page_num: int) -> list[dict[str, Any]]:
    tables: list[dict[str, Any]] = []
    i = 0
    n = len(visual_rows)

    while i < n:
        row = visual_rows[i]
        if is_table_header_row(row):
            header_row = row
            header_items = header_row["items"]
            headers = [it["text"].strip() for it in header_items]
            col_spans = [(it["box"]["x1"], it["box"]["x2"]) for it in header_items]

            data_rows: list[list[str]] = []
            raw_data_rows: list[list[dict[str, Any]]] = []
            all_table_items = list(header_items)

            j = i + 1
            while j < n:
                curr_row = visual_rows[j]
                curr_items = curr_row["items"]
                curr_text = curr_row["text"]

                # Stop conditions: major section headers or signature blocks
                if re.search(r"(?i)\b(doctor'?s? signature|physician signature|authorized signatory|dr\.\s+[a-zA-Z\s]+md)\b", curr_text):
                    break
                if re.search(r"(?i)\b(chief complaints?|clinical history|examination|vitals|investigations?|diagnosis|advice|recommendations?)\b", curr_text) and len(curr_text) < 40:
                    break

                # Row must have at least 1 item and fall within table horizontal span
                table_x1 = min(s[0] for s in col_spans) - 20
                table_x2 = max(s[1] for s in col_spans) + 20
                row_in_span = any(it["box"]["x1"] >= table_x1 and it["box"]["x2"] <= table_x2 for it in curr_items)

                if not row_in_span:
                    break

                # Map items to header columns
                aligned_cells: list[list[str]] = [[] for _ in col_spans]
                for it in curr_items:
                    it_cx = it["box"]["cx"]
                    # Find closest or overlapping column
                    best_col = 0
                    best_dist = float("inf")
                    for col_idx, (cx1, cx2) in enumerate(col_spans):
                        if cx1 - 15 <= it_cx <= cx2 + 15:
                            best_col = col_idx
                            best_dist = 0
                            break
                        dist = min(abs(it_cx - cx1), abs(it_cx - cx2))
                        if dist < best_dist:
                            best_dist = dist
                            best_col = col_idx
                    aligned_cells[best_col].append(it["text"].strip())

                row_cells = [" ".join(c).strip() for c in aligned_cells]
                # If row has at least one cell with content and row has multiple items or contains tabular data
                if any(row_cells) and (len(curr_items) >= 2 or any(re.search(r"\d", c) for c in row_cells)):
                    data_rows.append(row_cells)
                    raw_data_rows.append(curr_items)
                    all_table_items.extend(curr_items)
                    j += 1
                else:
                    break

            if len(data_rows) >= 1:
                confidences = [it.get("confidence", 0.95) for it in all_table_items if it.get("confidence") is not None]
                table_mean_conf = round(sum(confidences) / len(confidences), 4) if confidences else 0.95

                tables.append({
                    "page": page_num,
                    "headers": headers,
                    "rows": data_rows,
                    "rowCount": len(data_rows),
                    "colCount": len(headers),
                    "confidence": table_mean_conf,
                    "provenance": {
                        "header_items": [{"text": h["text"], "box": h["box"], "confidence": h.get("confidence", 1.0)} for h in header_items],
                        "raw_rows": [[{"text": it["text"], "box": it["box"], "confidence": it.get("confidence", 1.0)} for it in r] for r in raw_data_rows],
                    },
                })
                i = j
                continue
        i += 1

    return tables


if __name__ == "__main__":
    from pathlib import Path
    import asyncio
    from unittest.mock import MagicMock
    from app.modules.ocr.paddle_engine import PaddleOcrEngine
    from app.modules.ocr.quality_gate import QualityGate
    from app.services.pipeline.ocr_stage import OcrStageHandler

    fixture_path = Path("tests/fixtures/golden_docs/lab_1_.jpeg")
    image_bytes = fixture_path.read_bytes()
    engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True, cpu_threads=4)
    handler = OcrStageHandler(s3_client=None, vision_service=MagicMock(), paddle_engine=engine, quality_gate=QualityGate())
    res = asyncio.run(handler._extract_page_with_tiered_ocr(image_bytes, 1))

    raw_lines = res.get("lines", [])
    spatial_items = []
    for l in raw_lines:
        b = normalize_bounding_box(l.get("box"))
        if b:
            spatial_items.append({"text": l["text"], "confidence": l.get("confidence", 1.0), "box": b, "raw_box": l["box"]})

    v_rows = cluster_spatial_rows(spatial_items)
    extracted_tables = extract_tables_from_spatial_rows(v_rows, 1)
    print("Tables extracted count:", len(extracted_tables))
    for t in extracted_tables:
        print("Headers:", t["headers"])
        print("Row count:", t["rowCount"])
        print("Rows:")
        for r in t["rows"]:
            print(" ", r)
