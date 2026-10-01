from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


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
    and symbol noise ratios to decide whether an OCR result can be accepted or
    requires fallback to a multimodal vision language model (e.g. Qwen3-VL).
    """

    def __init__(
        self,
        min_mean_confidence: float = 0.82,
        min_char_count: int = 30,
        line_confidence_floor: float = 0.60,
        max_low_confidence_line_ratio: float = 0.20,
        min_alphanumeric_ratio: float = 0.40,
    ) -> None:
        self.min_mean_confidence = min_mean_confidence
        self.min_char_count = min_char_count
        self.line_confidence_floor = line_confidence_floor
        self.max_low_confidence_line_ratio = max_low_confidence_line_ratio
        self.min_alphanumeric_ratio = min_alphanumeric_ratio

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

        details = {
            "low_conf_line_count": low_conf_line_count,
            "total_lines": line_count,
            "char_count": char_count,
            "mean_confidence": round(mean_conf, 4),
            "min_confidence": round(min_conf, 4),
            "low_confidence_line_ratio": round(low_conf_ratio, 4),
            "alphanumeric_ratio": round(alnum_ratio, 4),
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
