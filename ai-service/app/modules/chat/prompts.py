from __future__ import annotations

import json


def chat_messages(message: str, context: dict) -> list[dict]:
    return [
        {
            "role": "system",
            "content": "You are a health AI. Use ONLY supplied context. Do not diagnose. Advise doctors for urgent care.",
        },
        {
            "role": "user",
            "content": f"""
User: {message}

Context:
{json.dumps(context, default=str, ensure_ascii=False)}

Answer conversationally based ONLY on context. Include uncertainty if needed.
""",
        },
    ]
