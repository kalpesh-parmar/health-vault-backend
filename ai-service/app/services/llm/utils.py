from __future__ import annotations

"""Prompt-conditioning helpers shared by every provider."""

import re

# Hard cap on the size of any single user-provided text we send to an LLM.
# Long OCR payloads dominate token cost; trimming here keeps requests fast
# and within the configured model context window without surprising spikes.
DEFAULT_MAX_PROMPT_CHARS = 64_000

_WHITESPACE_RUN = re.compile(r"[ \t\f\v]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")


def clean_prompt(text: str | None, *, max_chars: int = DEFAULT_MAX_PROMPT_CHARS) -> str:
    """Normalize whitespace and clamp length before sending to an LLM.

    * collapses runs of spaces/tabs to a single space
    * collapses 2+ blank lines to a single blank line
    * trims surrounding whitespace
    * truncates to `max_chars` safely at line boundaries if needed
    """
    if not text:
        return ""

    cleaned = _WHITESPACE_RUN.sub(" ", text)
    cleaned = _BLANK_LINES.sub("\n\n", cleaned)
    cleaned = cleaned.strip()

    if max_chars > 0 and len(cleaned) > max_chars:
        head_size = max_chars // 2
        tail_size = max_chars - head_size - 1

        # Look for clean line break near head_size
        head_cut = cleaned.rfind("\n", 0, head_size)
        if head_cut < head_size // 2:
            head_cut = head_size

        # Look for clean line break near tail_size
        tail_start = len(cleaned) - tail_size
        tail_cut = cleaned.find("\n", tail_start)
        if tail_cut == -1 or tail_cut > tail_start + (tail_size // 2):
            tail_cut = tail_start

        cleaned = cleaned[:head_cut].rstrip() + "\n...\n" + cleaned[tail_cut:].lstrip()

    return cleaned


def clean_messages(messages: list[dict], *, max_chars: int = DEFAULT_MAX_PROMPT_CHARS) -> list[dict]:
    """Apply :func:`clean_prompt` to every message's `content` field.

    Returns a new list — the input is not mutated. Messages with non-string
    content (e.g. multimodal inputs) are returned untouched.
    """
    cleaned: list[dict] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            cleaned_message = {**message, "content": clean_prompt(content, max_chars=max_chars)}
        else:
            cleaned_message = dict(message)
        cleaned.append(cleaned_message)
    return cleaned
