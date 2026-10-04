from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Single character exclusions for token fragmentation check
# Standalone digits (0-9) and these punctuation/units are NOT counted as fragments
SINGLE_CHAR_EXCLUSIONS = frozenset({
    "-", "+", "/", ".", ":", ",", ";", "(", ")", "[", "]", "=", "<", ">", "%",
    "g", "l", "m", "u", "s", "d", "h",
    "G", "L", "M", "U", "S", "D", "H",
})

# Comprehensive in-memory clinical, laboratory, pharmaceutical, and document vocabulary
CLINICAL_LEXICON = frozenset({
    # Common laboratory tests, analytes & panels
    "glucose", "fasting", "postprandial", "random", "cholesterol", "triglycerides",
    "creatinine", "urea", "bilirubin", "direct", "indirect", "protein", "albumin",
    "globulin", "ratio", "sodium", "potassium", "chloride", "calcium", "phosphorus",
    "magnesium", "uric", "acid", "amylase", "lipase", "alkaline", "phosphatase",
    "transaminase", "ferritin", "iron", "tibc", "vitamin", "folate", "thyroid",
    "stimulating", "hormone", "hemoglobin", "platelets", "neutrophils", "lymphocytes",
    "monocytes", "eosinophils", "basophils", "differential", "leukocyte", "erythrocyte",
    "smear", "peripheral", "routine", "microscopy", "pus", "cells", "epithelial",
    "casts", "crystals", "bacteria", "sugar", "acetone", "bile", "salts", "pigments",
    "urobilinogen", "stool", "occult", "culture", "sensitivity", "growth", "sterile",
    "isolated", "gram", "stain", "negative", "positive", "reactive", "nonreactive",
    "specimen", "serum", "plasma", "urine", "blood", "fluid", "csf", "swab", "sputum",

    # Units & abbreviations
    "mg", "dl", "ml", "ug", "mcg", "ng", "pg", "pmol", "mmol", "meq", "iu", "mu",
    "mmhg", "cumm", "mill", "thou", "fl", "bpm", "gm", "vol", "percent", "pct",
    "sec", "mins", "hrs", "hours", "days", "weeks", "months", "years", "yrs",

    # Vitals & clinical findings
    "bp", "pulse", "temp", "temperature", "weight", "height", "bmi", "spo2", "rr",
    "pr", "pallor", "icterus", "cyanosis", "clubbing", "edema", "lymphadenopathy",
    "chest", "abdomen", "heart", "lungs", "liver", "spleen", "kidney", "head", "neck",
    "fever", "cough", "cold", "pain", "headache", "vomiting", "nausea", "diarrhea",
    "weakness", "fatigue", "dyspnea", "hypertension", "diabetes", "mellitus", "asthma",
    "copd", "gerd", "infection", "allergy", "clear", "turbid", "yellow", "pale",
    "straw", "amber", "trace", "nil", "absent", "present", "moderate", "marked",
    "severe", "mild", "acute", "chronic", "normal", "abnormal", "high", "low",

    # Prescriptions, forms & medications
    "rx", "tab", "tablet", "tablets", "cap", "capsule", "capsules", "syp", "syrup",
    "inj", "injection", "oint", "ointment", "drops", "cream", "gel", "lotion",
    "oral", "daily", "once", "twice", "thrice", "morning", "night", "afternoon",
    "bedtime", "before", "after", "food", "meals", "od", "bd", "bid", "tid", "qid",
    "hs", "sos", "stat", "prn", "dose", "dosage", "duration", "qty", "quantity",
    "paracetamol", "amoxicillin", "clavulanate", "azithromycin", "ciprofloxacin",
    "ofloxacin", "cefixime", "cefpodoxime", "metronidazole", "doxycycline",
    "pantoprazole", "omeprazole", "rabeprazole", "esomeprazole", "ranitidine",
    "famotidine", "antacid", "cetirizine", "levocetirizine", "loratadine",
    "fexofenadine", "montelukast", "ibuprofen", "diclofenac", "aceclofenac",
    "tramadol", "metformin", "glimepiride", "gliclazide", "vildagliptin",
    "sitagliptin", "dapagliflozin", "empagliflozin", "insulin", "amlodipine",
    "telmisartan", "losartan", "olmesartan", "ramipril", "enalapril", "atenolol",
    "metoprolol", "bisoprolol", "carvedilol", "atorvastatin", "rosuvastatin",
    "aspirin", "clopidogrel", "levothyroxine", "prednisolone", "dexamethasone",
    "salbutamol", "budesonide", "formoterol", "ondansetron", "domperidone",
    "multivitamin", "folic", "calcium", "zinc", "b12", "d3",

    # Administrative, report headers & general vocabulary
    "patient", "name", "age", "sex", "gender", "male", "female", "dob", "date",
    "time", "dr", "mr", "mrs", "ms", "doctor", "physician", "consultant", "hospital",
    "clinic", "healthcare", "center", "centre", "ward", "bed", "room", "floor",
    "opd", "ipd", "emergency", "admission", "discharge", "diagnosis", "provisional",
    "final", "history", "examination", "vitals", "investigation", "department",
    "pathology", "biochemistry", "hematology", "microbiology", "serology", "radiology",
    "verified", "authorized", "sign", "signature", "signatory", "pathologist",
    "technician", "notes", "clinical", "remarks", "sample", "collected", "received",
    "reported", "printed", "status", "address", "phone", "tel", "mob", "mobile",
    "reg", "id", "no", "page", "total", "count", "value", "method", "impression",
    "interpretation", "finding", "findings", "advice", "treatment", "consultation",
    "medical", "health", "care", "laboratory", "labs", "diagnostic", "diagnostics",
    "reference", "interval", "range", "ranges", "unit", "units", "comment", "comments",
    "remark", "note", "recommendation", "correlation", "suggested", "clinically",
    "receipt", "invoice", "bill", "cash", "credit", "amount", "paid", "due", "balance",
    "tax", "gst", "uhid", "mrn", "referred", "ref", "by",

    # High frequency English stopwords / connectors
    "the", "of", "and", "in", "to", "for", "with", "on", "at", "by", "from",
    "is", "was", "are", "were", "been", "has", "have", "had", "this", "that",
    "these", "those", "not", "or", "as", "an", "be", "all", "any", "each",
    "every", "both", "few", "more", "most", "other", "some", "such", "than",
    "too", "very", "can", "will", "just", "should", "now", "after", "before",
    "between", "under", "over", "above", "below", "into", "out", "up", "down",
    "only", "also", "then", "there", "where", "which", "who", "whom", "whose",
    "when", "while", "during", "end", "please", "correlate",
})

try:
    from app.modules.file_processing.pdf_text import _COMMON_LEXICON
    CLINICAL_LEXICON = CLINICAL_LEXICON | _COMMON_LEXICON
except Exception:
    pass


@dataclass
class QualityGateResult:
    """Outcome of evaluating OCR output quality against deterministic standards."""
    passed: bool
    reason: str
    has_unread_non_latin: bool = False
    mean_confidence: float = 0.0
    min_confidence: float = 0.0
    line_count: int = 0
    char_count: int = 0
    low_confidence_line_ratio: float = 0.0
    alphanumeric_ratio: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)


class QualityGate:
    """Deterministic quality evaluator for primary OCR output.
    
    Evaluates mean confidence, character yield, line-level confidence distributions,
    symbol noise ratios, token fragmentation, lexical validity, and borderline confidence
    to decide whether an OCR result can be accepted or requires fallback to a
    multimodal vision language model (e.g. Qwen3-VL).
    """

    def __init__(
        self,
        min_mean_confidence: float = 0.82,
        min_char_count: int = 30,
        line_confidence_floor: float = 0.60,
        max_low_confidence_line_ratio: float = 0.20,
        min_alphanumeric_ratio: float = 0.40,
        max_fragment_ratio: float = 0.35,
        min_avg_token_len: float = 2.5,
        min_valid_token_ratio: float = 0.35,
        borderline_min_conf: float = 0.70,
        borderline_max_conf: float = 0.85,
    ) -> None:
        self.min_mean_confidence = min_mean_confidence
        self.min_char_count = min_char_count
        self.line_confidence_floor = line_confidence_floor
        self.max_low_confidence_line_ratio = max_low_confidence_line_ratio
        self.min_alphanumeric_ratio = min_alphanumeric_ratio
        self.max_fragment_ratio = max_fragment_ratio
        self.min_avg_token_len = min_avg_token_len
        self.min_valid_token_ratio = min_valid_token_ratio
        self.borderline_min_conf = borderline_min_conf
        self.borderline_max_conf = borderline_max_conf

    def evaluate(
        self,
        ocr_result: dict[str, Any],
        script_hint: dict[str, Any] | None = None,
    ) -> QualityGateResult:
        """Evaluate raw OCR dictionary returned by PaddleOcrEngine.
        
        Expected input format:
        {
            "lines": [{"text": str, "confidence": float, ...}],
            "full_text": str,
            "mean_confidence": float,
            "min_confidence": float,
            "line_count": int,
            "char_count": int,
        }
        """
        if not ocr_result:
            return QualityGateResult(
                passed=False,
                reason="OCR result payload is empty or None",
            )

        full_text = (ocr_result.get("full_text") or ocr_result.get("text") or "").strip()
        lines = ocr_result.get("lines") or []
        line_count = len(lines)
        char_count = len(full_text)

        mean_conf = float(ocr_result.get("mean_confidence") or 0.0)
        min_conf = float(ocr_result.get("min_confidence") or 0.0)

        # If confidences not precalculated, derive them directly from lines
        if not mean_conf and lines:
            confs = [float(l.get("confidence") or 0.0) for l in lines]
            mean_conf = sum(confs) / len(confs) if confs else 0.0
            min_conf = min(confs) if confs else 0.0

        # Calculate low confidence line ratio
        low_conf_line_count = 0
        if lines:
            low_conf_line_count = sum(
                1 for l in lines if float(l.get("confidence") or 0.0) < self.line_confidence_floor
            )
            low_conf_ratio = low_conf_line_count / line_count
        else:
            low_conf_ratio = 1.0 if char_count == 0 else 0.0

        # Calculate alphanumeric ratio
        if char_count > 0:
            alnum_count = sum(1 for c in full_text if c.isalnum())
            alnum_ratio = alnum_count / char_count
        else:
            alnum_ratio = 0.0

        # Calculate tokens and fragmentation metrics
        tokens = full_text.split()
        total_tokens = len(tokens)

        # Single-character tokens (excluding digits, punctuation, and single-char medical units)
        fragment_count = sum(
            1 for t in tokens
            if len(t) == 1 and not t.isdigit() and t not in SINGLE_CHAR_EXCLUSIONS
        )
        fragment_ratio = fragment_count / total_tokens if total_tokens > 0 else 0.0
        avg_token_len = (sum(len(t) for t in tokens) / total_tokens) if total_tokens > 0 else 0.0

        # Valid-token lexical check against clinical and general lexicon
        alpha_words = re.findall(r"[a-zA-Z]+", full_text)
        if alpha_words:
            valid_token_count = sum(1 for w in alpha_words if w.lower() in CLINICAL_LEXICON)
            valid_token_ratio = valid_token_count / len(alpha_words)
        else:
            valid_token_ratio = 1.0

        # Borderline confidence flag
        is_borderline = (self.borderline_min_conf <= mean_conf <= self.borderline_max_conf)

        details = {
            "low_conf_line_count": low_conf_line_count,
            "total_lines": line_count,
            "char_count": char_count,
            "mean_confidence": round(mean_conf, 4),
            "min_confidence": round(min_conf, 4),
            "low_confidence_line_ratio": round(low_conf_ratio, 4),
            "alphanumeric_ratio": round(alnum_ratio, 4),
            "fragment_ratio": round(fragment_ratio, 4),
            "avg_token_len": round(avg_token_len, 4),
            "valid_token_ratio": round(valid_token_ratio, 4),
            "is_borderline": is_borderline,
        }

        # 0. Check Non-Latin Script Invariant (Invariant 3)
        from app.modules.ocr.script_detector import (
            detect_scripts_in_text,
            inspect_ocr_lines_for_non_latin,
        )

        script_info = script_hint if script_hint is not None else inspect_ocr_lines_for_non_latin(lines)
        text_script_info = detect_scripts_in_text(full_text)

        if script_info.get("has_potential_unread_non_latin") and text_script_info.get("non_latin_count", 0) == 0:
            logger.info("QualityGate rejected: UNREAD_NON_LATIN_SCRIPT (detected non-Latin indicators with 0 recognized non-Latin glyphs)")
            return QualityGateResult(
                passed=False,
                reason="UNREAD_NON_LATIN_SCRIPT",
                has_unread_non_latin=True,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details={**details, "script_info": script_info},
            )

        # 1. Total character yield check
        if char_count == 0:
            logger.info("QualityGate rejected: zero characters extracted")
            return QualityGateResult(
                passed=False,
                reason="Zero characters extracted by OCR engine",
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        if char_count < self.min_char_count:
            reason = (
                f"Character count ({char_count}) is below minimum threshold ({self.min_char_count})"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        # 2. Mean confidence check
        if mean_conf < self.min_mean_confidence:
            reason = (
                f"Mean confidence ({mean_conf:.3f}) is below threshold ({self.min_mean_confidence:.3f})"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        # 3. Low confidence line distribution check
        if low_conf_ratio > self.max_low_confidence_line_ratio:
            reason = (
                f"Low confidence line ratio ({low_conf_ratio:.1%}) exceeds maximum allowed "
                f"({self.max_low_confidence_line_ratio:.1%})"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        # 4. Alphanumeric / noise ratio check
        if alnum_ratio < self.min_alphanumeric_ratio:
            reason = (
                f"Alphanumeric ratio ({alnum_ratio:.1%}) is below minimum allowed "
                f"({self.min_alphanumeric_ratio:.1%})"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        # 5. Token fragmentation checks
        if total_tokens > 0 and fragment_ratio > self.max_fragment_ratio:
            reason = (
                f"EXCESSIVE_TOKEN_FRAGMENTATION: fragment ratio ({fragment_ratio:.1%}) "
                f"exceeds maximum allowed ({self.max_fragment_ratio:.1%})"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        if total_tokens > 10 and avg_token_len < self.min_avg_token_len:
            reason = (
                f"LOW_AVERAGE_TOKEN_LENGTH: average token length ({avg_token_len:.2f}) "
                f"is below minimum allowed ({self.min_avg_token_len:.2f})"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        # 6. Valid-token lexical ratio check
        if char_count > 30 and valid_token_ratio < self.min_valid_token_ratio:
            reason = (
                f"LOW_VALID_TOKEN_RATIO: valid token ratio ({valid_token_ratio:.1%}) "
                f"is below minimum allowed ({self.min_valid_token_ratio:.1%})"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        # 7. Borderline confidence inspection
        if is_borderline and valid_token_ratio < 0.50:
            reason = (
                f"BORDERLINE_LOW_VALIDITY: borderline confidence ({mean_conf:.3f}) "
                f"with valid token ratio ({valid_token_ratio:.1%}) below 50%"
            )
            logger.info("QualityGate rejected: %s", reason)
            return QualityGateResult(
                passed=False,
                reason=reason,
                mean_confidence=mean_conf,
                min_confidence=min_conf,
                line_count=line_count,
                char_count=char_count,
                low_confidence_line_ratio=low_conf_ratio,
                alphanumeric_ratio=alnum_ratio,
                details=details,
            )

        # All checks passed
        return QualityGateResult(
            passed=True,
            reason="Quality gate passed",
            mean_confidence=mean_conf,
            min_confidence=min_conf,
            line_count=line_count,
            char_count=char_count,
            low_confidence_line_ratio=low_conf_ratio,
            alphanumeric_ratio=alnum_ratio,
            details=details,
        )

