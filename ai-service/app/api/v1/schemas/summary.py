from __future__ import annotations

from pydantic import BaseModel


class SummaryRequest(BaseModel):
    text: str
    mode: str = "concise"
    document_type: str = "medical"

