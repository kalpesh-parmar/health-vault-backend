from __future__ import annotations

from pydantic import BaseModel, Field


class DirectOcrRequest(BaseModel):
    bucket: str
    file_key: str = Field(alias="fileKey")
    mime_type: str | None = Field(default=None, alias="mimeType")
    language_hints: list[str] = Field(default_factory=lambda: ["en"], alias="languageHints")

    class Config:
        populate_by_name = True
