from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class FallbackValidationResult:
    """Result of validating fallback model output."""
    is_valid: bool
    reason: str = ""
    target_script_share: float = 0.0
    detected_loop_snippet: str = ""
    details: dict[str, Any] = field(default_factory=dict)


class FallbackOutputValidator:
    """Validates VLM fallback output against degenerate loops, empty yields,
    premature truncation, and script collapse.
    """

    SCRIPT_RANGES: dict[str, tuple[int, int]] = {
        "devanagari": (0x0900, 0x097F),
        "hindi": (0x0900, 0x097F),
        "marathi": (0x0900, 0x097F),
        "tamil": (0x0B80, 0x0BFF),
        "ta": (0x0B80, 0x0BFF),
        "gujarati": (0x0A80, 0x0AFF),
        "gu": (0x0A80, 0x0AFF),
    }

    def __init__(
        self,
        min_chars: int = 10,
        max_consecutive_repeated_lines: int = 3,
        max_repeated_ngram_cycles: int = 4,
    ) -> None:
        self.min_chars = min_chars
        self.max_consecutive_repeated_lines = max_consecutive_repeated_lines
        self.max_repeated_ngram_cycles = max_repeated_ngram_cycles

    def detect_degenerate_loops(self, text: str) -> tuple[bool, str]:
        """Detect identical consecutive lines or cyclic repeating phrase patterns."""
        if not text:
            return False, ""

        lines = [l.strip() for l in text.splitlines() if l.strip()]
        if len(lines) >= self.max_consecutive_repeated_lines:
            consecutive_count = 1
            for i in range(1, len(lines)):
                if lines[i] == lines[i - 1]:
                    consecutive_count += 1
                    if consecutive_count >= self.max_consecutive_repeated_lines:
                        return True, f"Repeated line: '{lines[i][:40]}'"
                else:
                    consecutive_count = 1

        # Token-level cyclic phrase repetition check (n-grams of size 2 to 6 repeating >= max_repeated_ngram_cycles)
        tokens = text.split()
        num_tokens = len(tokens)
        if num_tokens >= 8:
            for n in range(2, min(7, num_tokens // 3)):
                for start in range(num_tokens - (n * self.max_repeated_ngram_cycles) + 1):
                    pattern = tokens[start : start + n]
                    matches = 1
                    idx = start + n
                    while idx + n <= num_tokens and tokens[idx : idx + n] == pattern:
                        matches += 1
                        idx += n
                        if matches >= self.max_repeated_ngram_cycles:
                            pattern_str = " ".join(pattern)
                            return True, f"Cyclic pattern ({matches}x): '{pattern_str[:40]}'"

        return False, ""

    def validate_target_script(self, text: str, expected_script: str | None) -> tuple[bool, float, str]:
        """Validate that text contains target script characters when an Indic script was expected."""
        if not expected_script:
            return True, 1.0, ""

        script_key = expected_script.lower().strip()
        if script_key not in self.SCRIPT_RANGES:
            return True, 1.0, ""

        min_code, max_code = self.SCRIPT_RANGES[script_key]
        total_chars = sum(1 for c in text if not c.isspace())
        if total_chars == 0:
            return False, 0.0, "EMPTY_TEXT"

        target_chars = sum(1 for c in text if min_code <= ord(c) <= max_code)
        ratio = target_chars / total_chars

        if target_chars == 0:
            return False, 0.0, f"SCRIPT_COLLAPSE_NO_{script_key.upper()}_CHARS"

        return True, ratio, ""

    def validate_termination(
        self, text: str, finish_reason: str | None = None, min_chars: int | None = None
    ) -> tuple[bool, str]:
        """Validate response termination against emptiness and premature truncation."""
        threshold = min_chars or self.min_chars
        stripped = text.strip()
        if not stripped:
            return False, "EMPTY_RESPONSE"

        if len(stripped) < threshold:
            if finish_reason == "length":
                return False, "PREMATURE_LENGTH_TERMINATION"

        return True, ""

    def validate(
        self,
        text: str,
        *,
        finish_reason: str | None = None,
        expected_script: str | None = None,
        min_chars: int | None = None,
    ) -> FallbackValidationResult:
        """Run all fallback validation checks."""
        term_valid, term_reason = self.validate_termination(text, finish_reason=finish_reason, min_chars=min_chars)
        if not term_valid:
            return FallbackValidationResult(is_valid=False, reason=term_reason)

        loop_detected, loop_snippet = self.detect_degenerate_loops(text)
        if loop_detected:
            return FallbackValidationResult(
                is_valid=False,
                reason="DEGENERATE_LOOP",
                detected_loop_snippet=loop_snippet,
            )

        script_valid, script_share, script_reason = self.validate_target_script(text, expected_script)
        if not script_valid:
            return FallbackValidationResult(
                is_valid=False,
                reason=script_reason,
                target_script_share=script_share,
            )

        return FallbackValidationResult(
            is_valid=True,
            reason="",
            target_script_share=script_share,
        )
