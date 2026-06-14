from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_JSON_FENCE = re.compile(r"```(?:json)?|```", re.IGNORECASE)


def extract_json_block(text: str) -> str:
    """Remove markdown code fences around a JSON block."""
    if not text:
        return ""
    return _JSON_FENCE.sub("", text.strip()).strip()


def extract_first_json_object(text: str) -> str | None:
    """Find the first matching '{' and '}' or '[' and ']' sequence to extract raw JSON."""
    start_curly = text.find("{")
    start_bracket = text.find("[")

    if start_curly < 0 and start_bracket < 0:
        return None

    # Determine whether object or array starts first
    if start_curly >= 0 and (start_bracket < 0 or start_curly < start_bracket):
        start = start_curly
        start_char = "{"
        end_char = "}"
    else:
        start = start_bracket
        start_char = "["
        end_char = "]"

    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == start_char:
            depth += 1
        elif char == end_char:
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def parse_json_object(text: str) -> Any:
    """Attempt to parse JSON from the text, handling code fences and trailing/leading junk.

    Raises json.JSONDecodeError if parsing fails completely.
    """
    if not text or not text.strip():
        raise ValueError("Empty input string")

    # Step 1: Clean code fences
    cleaned = extract_json_block(text)

    # Step 2: Try direct parse
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as direct_err:
        # Step 3: Try extracting the first JSON object/array structure
        extracted = extract_first_json_object(cleaned)
        if extracted:
            try:
                return json.loads(extracted)
            except json.JSONDecodeError:
                pass
        raise direct_err
