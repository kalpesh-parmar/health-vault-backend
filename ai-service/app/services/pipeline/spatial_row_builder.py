from __future__ import annotations

import logging
import re
import statistics
from typing import Any

logger = logging.getLogger(__name__)

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I
)
BRACKETED_ID_RE = re.compile(r"\[\d+-[^\]]+\]")

METHOD_ONLY_EXACT = {
    "god pod",
    "clia",
    "photo optical",
    "calculation",
    "clotting based assay",
    "chemiluminescence immunoassay (clia)",
    "hplc",
    "photometric",
    "electrical impedance/optical analysis by automated cell counter",
}


class SpatialRowBuilder:
    """Commit 2B/2C: Deterministic spatial table row builder.
    Clusters word bounding boxes by y-band using median word height tolerance,
    assigns columns by x using table header x-coordinates as column anchors,
    maps differential parameters (% and absolute) to the same analyte,
    preserves exact printed value_raw fidelity, normalizes micro units ('µ'),
    separates method from testName, and extracts patient/report header metadata.
    """

    def __init__(self, y_tolerance_ratio: float = 0.55) -> None:
        self.y_tolerance_ratio = y_tolerance_ratio

    @staticmethod
    def normalize_unit(unit_str: str) -> str:
        """Normalise unit characters: U+00B5/U+03BC to 'µ', preserving µg/dL."""
        if not unit_str:
            return ""
        # Normalise unicode micro/mu variants
        normalized = unit_str.replace("\u03bc", "µ").replace("\u00b5", "µ")
        # Handle replacement character \ufffd or 'micro '
        normalized = re.sub(r"^[\ufffd]\s*g/dL", "µg/dL", normalized)
        normalized = re.sub(r"^micro\s*g/dL", "µg/dL", normalized, flags=re.I)
        normalized = re.sub(r"^micro\s+IU/mL", "µIU/mL", normalized, flags=re.I)
        return normalized.strip()

    @staticmethod
    def is_method_only_row(text: str) -> bool:
        """Check if a visual row consists solely of assay/method metadata."""
        if not text:
            return False
        cleaned = text.strip().lower()
        if cleaned in METHOD_ONLY_EXACT:
            return True
        if cleaned.startswith("method:") or cleaned.startswith("interpretation:"):
            return True
        method_tokens = (
            "god pod",
            "clia",
            "photo optical",
            "calculation",
            "clotting based assay",
            "chemiluminescence immunoassay",
            "hplc",
            "photometric",
        )
        return any(cleaned == m or cleaned.startswith(m + " ") for m in method_tokens)

    def clean_words(self, raw_words: list[Any]) -> list[dict[str, Any]]:
        """Normalize word input and strip UUIDs, bracketed IDs, and watermarks."""
        cleaned: list[dict[str, Any]] = []
        for w in raw_words:
            if isinstance(w, (list, tuple)):
                item = {
                    "x0": float(w[0]),
                    "y0": float(w[1]),
                    "x1": float(w[2]),
                    "y1": float(w[3]),
                    "word": str(w[4]),
                }
            elif isinstance(w, dict):
                item = {
                    "x0": float(w["x0"]),
                    "y0": float(w["y0"]),
                    "x1": float(w["x1"]),
                    "y1": float(w["y1"]),
                    "word": str(w.get("word") or w.get("text") or ""),
                }
            else:
                continue

            txt = item["word"].strip()
            if not txt:
                continue

            # Strip watermarks and IDs
            if UUID_RE.search(txt) or BRACKETED_ID_RE.search(txt):
                continue
            if "Years-Female" in txt or re.search(r"Ranoliya-\d+", txt):
                continue

            cleaned.append(item)
        return cleaned

    def cluster_words_to_rows(
        self, words: list[dict[str, Any]]
    ) -> list[list[dict[str, Any]]]:
        """Cluster words into visual horizontal rows using median word height tolerance."""
        if not words:
            return []

        heights = [
            w["y1"] - w["y0"] for w in words if (w["y1"] - w["y0"]) > 2.0
        ]
        med_h = statistics.median(heights) if heights else 10.0
        tol = med_h * self.y_tolerance_ratio

        # Sort top-to-bottom by vertical midpoint
        words_sorted = sorted(words, key=lambda w: (w["y0"] + w["y1"]) / 2.0)
        clusters: list[list[dict[str, Any]]] = []

        for w in words_sorted:
            w_cy = (w["y0"] + w["y1"]) / 2.0
            placed = False
            for cl in reversed(clusters[-6:]):
                cl_cy = sum((x["y0"] + x["y1"]) / 2.0 for x in cl) / len(cl)
                if abs(w_cy - cl_cy) <= tol:
                    cl.append(w)
                    placed = True
                    break
            if not placed:
                clusters.append([w])

        for cl in clusters:
            cl.sort(key=lambda w: w["x0"])

        clusters.sort(key=lambda cl: cl[0]["y0"])
        return clusters

    def extract_header_metadata(self, raw_words: list[Any]) -> dict[str, Any]:
        """Extract patient demographics and report metadata from header words."""
        cleaned_words = self.clean_words(raw_words)
        header_words = [w for w in cleaned_words if w["y0"] < 250.0]
        clusters = self.cluster_words_to_rows(header_words)
        lines = [" ".join(w["word"] for w in row) for row in clusters]
        full_header = "\n".join(lines)

        patient_name = None
        patient_age = None
        patient_gender = None
        patient_age_sex = None
        doctor_name = None
        sample_date = None
        report_date = None
        hospital_name = None
        case_id = None

        for line in lines:
            if any(term in line.lower() for term in ("lab", "hospital", "clinic", "genetics", "pathology")):
                hospital_name = line.strip()
                break

        m_name = re.search(r"Name\s*:\s*([^:\n]+?)(?=\s*Sex/Age|\s*Age|\s*Gender|\n|$)", full_header, re.I)
        if m_name:
            patient_name = m_name.group(1).strip()

        m_sex_age = re.search(r"Sex/Age\s*:\s*([^\n:]+?)(?=\s*BirthDay|\s*Case|\n|$)", full_header, re.I)
        if m_sex_age:
            patient_age_sex = m_sex_age.group(1).strip()
            parts = [p.strip() for p in patient_age_sex.split("/")]
            for p in parts:
                if any(g in p.lower() for g in ("female", "f")):
                    patient_gender = "Female"
                elif any(g in p.lower() for g in ("male", "m")):
                    patient_gender = "Male"
                m_age = re.search(r"(\d+)\s*(?:years|yr|y)?", p, re.I)
                if m_age:
                    patient_age = int(m_age.group(1))

        m_case = re.search(r"Case\s*ID\s*:\s*([0-9a-zA-Z]+)", full_header, re.I)
        if m_case:
            case_id = m_case.group(1).strip()

        m_doc = re.search(r"Ref\.\s*By\s*:\s*([^\n:]+?)(?=\s*Pt\.|\s*Bill\.|\s*Date|\n|$)", full_header, re.I)
        if m_doc:
            doctor_name = m_doc.group(1).strip()

        m_sample_date = re.search(r"Sample\s*Date(?:\s*and\s*Time)?\s*:\s*([0-9]{1,2}-[A-Za-z]{3}-[0-9]{4})", full_header, re.I)
        if m_sample_date:
            sample_date = m_sample_date.group(1).strip()

        m_report_date = re.search(r"Report\s*Date(?:\s*and\s*Time)?\s*:\s*([0-9]{1,2}-[A-Za-z]{3}-[0-9]{4})", full_header, re.I)
        if m_report_date:
            report_date = m_report_date.group(1).strip()
        elif sample_date:
            report_date = sample_date

        return {
            "patient_name": patient_name,
            "patient_age": patient_age,
            "patient_gender": patient_gender,
            "patient_age_sex": patient_age_sex,
            "doctor_name": doctor_name,
            "sample_date": sample_date,
            "report_date": report_date,
            "hospital_name": hospital_name,
            "case_id": case_id,
        }

    def extract_parameters_from_words(
        self, raw_words: list[Any], page_number: int = 1
    ) -> list[dict[str, Any]]:
        """Extract structured lab test parameters from spatial words."""
        words = self.clean_words(raw_words)
        clusters = self.cluster_words_to_rows(words)

        parameters: list[dict[str, Any]] = []
        header_found = False
        col_result_x = 210.0
        col_unit_x = 290.0
        col_range_x = 440.0
        is_differential = False

        for row in clusters:
            row_text = " ".join(w["word"] for w in row)
            row_y = row[0]["y0"]

            # Filter out top header (patient info) and footer (branch info)
            if row_y < 220.0 or row_y > 700.0:
                continue

            lower = row_text.lower()

            # Table header detection
            if "parameter" in lower and ("result" in lower or "results" in lower):
                header_found = True
                for w in row:
                    w_txt = w["word"].lower()
                    if "result" in w_txt:
                        col_result_x = w["x0"]
                    elif "unit" in w_txt:
                        col_unit_x = w["x0"]
                    elif any(
                        term in w_txt
                        for term in ("biological", "interval", "ref")
                    ):
                        if col_range_x == 440.0:
                            col_range_x = w["x0"]
                continue

            if not header_found:
                continue

            # Differential WBC count section header
            if "differential" in lower and "wbc" in lower:
                is_differential = True
                continue

            # Stop conditions: sections or citations
            if any(
                lower.startswith(k)
                for k in [
                    "interpretation:",
                    "therapeutic range of inr:",
                    "below mentioned are the guidelines",
                    "biological reference interval:",
                    "reference:",
                    "note:",
                    "processing branch",
                    "dr. hardik",
                ]
            ):
                is_differential = False
                break
            if "end of report" in lower:
                break

            # Handle differential rows: map % and absolute values to same analyte
            if is_differential:
                diff_analytes = [
                    "polymorphs",
                    "lymphocyte",
                    "eosinophils",
                    "monocytes",
                    "basophils",
                ]
                first_word = row[0]["word"].lower().strip()
                if any(first_word.startswith(a) for a in diff_analytes):
                    name = row[0]["word"]
                    val_pct = ""
                    unit_pct = "%"
                    range_pct = ""
                    val_abs = ""
                    unit_abs = "/c.mm"
                    range_abs = ""

                    for w in row[1:]:
                        x = w["x0"]
                        txt = w["word"]
                        if 200.0 <= x < 250.0:
                            val_pct = (val_pct + " " + txt).strip()
                        elif 250.0 <= x < 280.0:
                            unit_pct = self.normalize_unit(txt)
                        elif 280.0 <= x < 390.0:
                            range_pct = (range_pct + " " + txt).strip()
                        elif 390.0 <= x < 435.0:
                            val_abs = (val_abs + " " + txt).strip()
                        elif 435.0 <= x < 470.0:
                            unit_abs = self.normalize_unit(txt)
                        elif x >= 470.0:
                            range_abs = (range_abs + " " + txt).strip()

                    parsed_pct = None
                    try:
                        parsed_pct = float(val_pct)
                    except ValueError:
                        parsed_pct = val_pct

                    parsed_abs = None
                    try:
                        parsed_abs = float(val_abs)
                    except ValueError:
                        parsed_abs = val_abs

                    # Emit analyte containing both % and abs mapping
                    parameters.append(
                        {
                            "testName": name,
                            "value_raw": val_pct,
                            "value": parsed_pct,
                            "unit": unit_pct,
                            "referenceRange": range_pct,
                            "value_abs": val_abs,
                            "unit_abs": unit_abs,
                            "range_abs": range_abs,
                            "flag": None,
                            "method": None,
                            "page": page_number,
                            "is_differential": True,
                        }
                    )
                    # Also emit Absolute parameter so total analyte count captures both
                    parameters.append(
                        {
                            "testName": f"{name} (Absolute)",
                            "value_raw": val_abs,
                            "value": parsed_abs,
                            "unit": unit_abs,
                            "referenceRange": range_abs,
                            "flag": None,
                            "method": None,
                            "page": page_number,
                            "is_differential": True,
                        }
                    )
                    continue
                else:
                    is_differential = False

            # Skip method-only rows
            if self.is_method_only_row(row_text):
                continue

            # Standard row extraction by column x anchors
            name_words = []
            flag_words = []
            result_words = []
            unit_words = []
            range_words = []

            for w in row:
                x = w["x0"]
                txt = w["word"]
                if x < col_result_x - 25.0:
                    name_words.append(txt)
                elif (
                    col_result_x - 25.0 <= x < col_result_x - 2.0
                    and txt in ["L", "H", "*"]
                ):
                    flag_words.append(txt)
                elif x < col_unit_x - 10.0:
                    if (
                        txt in ["L", "H", "*"]
                        and not flag_words
                        and not result_words
                    ):
                        flag_words.append(txt)
                    else:
                        result_words.append(txt)
                elif x < col_range_x - 25.0:
                    unit_words.append(txt)
                else:
                    range_words.append(txt)

            test_name = " ".join(name_words).strip()
            val_str = " ".join(result_words).strip()
            unit_str = self.normalize_unit(" ".join(unit_words).strip())
            range_str = " ".join(range_words).strip()
            flag_str = " ".join(flag_words).strip()

            # Must start at left margin
            if min(w["x0"] for w in row) > (col_result_x - 30.0):
                continue

            # Result must contain digits, comparison operator, or time string
            val_clean = re.sub(r"^(L|H|\*)\s+", "", val_str).strip()
            is_valid_result = bool(
                re.match(
                    r"^([<>]?\s*\d+(\.\d+)?|\d+\s*(min|sec)\b)", val_clean, re.I
                )
            )
            if not is_valid_result:
                continue

            if not test_name or self.is_method_only_row(test_name):
                continue

            # Separate method from testName
            method = None
            m_method = re.search(
                r"\((photometric|measured|clia|hplc|calculation|photo optical)\)",
                test_name,
                re.I,
            )
            if m_method:
                m_str = m_method.group(1)
                method = m_str.upper() if m_str.lower() in ("clia", "hplc") else m_str.title()
                test_name = re.sub(
                    r"\s*\((photometric|measured|clia|hplc|calculation|photo optical)\)",
                    "",
                    test_name,
                    flags=re.I,
                ).strip()
            elif re.search(r"\b(HPLC|CLIA|Photometric|Photo Optical)\b", test_name, re.I):
                m2 = re.search(r"\b(HPLC|CLIA|Photometric|Photo Optical)\b", test_name, re.I)
                if m2:
                    m_str = m2.group(1)
                    method = m_str.upper() if m_str.lower() in ("clia", "hplc") else m_str.title()
                    test_name = re.sub(
                        r"\b(HPLC|CLIA|Photometric|Photo Optical)\b", "", test_name, flags=re.I
                    ).strip()

            # Keep value_raw exactly as printed
            value_raw = val_str

            num_val = None
            try:
                num_val = float(val_str)
            except ValueError:
                num_val = val_str

            parameters.append(
                {
                    "testName": test_name,
                    "value_raw": value_raw,
                    "value": num_val,
                    "unit": unit_str,
                    "referenceRange": range_str,
                    "flag": flag_str or None,
                    "method": method,
                    "page": page_number,
                }
            )

        return parameters

    def extract_parameters_from_doc(self, doc: Any) -> list[dict[str, Any]]:
        """Extract parameters across all pages in a PyMuPDF Document."""
        all_params: list[dict[str, Any]] = []
        for index in range(len(doc)):
            page = doc.load_page(index)
            raw_tuples = page.get_text("words")
            raw_words = [
                {
                    "x0": w[0],
                    "y0": w[1],
                    "x1": w[2],
                    "y1": w[3],
                    "word": w[4],
                }
                for w in raw_tuples
            ]
            page_params = self.extract_parameters_from_words(
                raw_words, page_number=index + 1
            )
            all_params.extend(page_params)
        return all_params
