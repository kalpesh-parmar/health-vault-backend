from __future__ import annotations

import json


def chat_messages(message: str, context: dict) -> list[dict]:
    return [
        {
            "role": "system",
            "content": (
                "You are Health Vault's self-hosted healthcare assistant. "
                "Use only supplied context for user-specific facts. "
                "Do not diagnose, prescribe, or override a clinician. "
                "For urgent symptoms, advise immediate professional care."
            ),
        },
        {
            "role": "user",
            "content": f"""
User message:
{message}

Context JSON:
{json.dumps(context, default=str, ensure_ascii=False)}

Answer conversationally. Include uncertainty when OCR or medication validation is low confidence.
""",
        },
    ]
