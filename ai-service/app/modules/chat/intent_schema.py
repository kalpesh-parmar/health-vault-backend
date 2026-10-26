from enum import Enum
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field

class IntentType(str, Enum):
    DOCUMENT_SUMMARY = "DOCUMENT_SUMMARY"
    FACT_LOOKUP = "FACT_LOOKUP"
    MEDICAL_EXPLANATION = "MEDICAL_EXPLANATION"
    MEDICATION_LOOKUP = "MEDICATION_LOOKUP"
    DOCUMENT_COMPARISON = "DOCUMENT_COMPARISON"
    MEDICAL_TREND_CHART = "MEDICAL_TREND_CHART"
    TABLE_REQUEST = "TABLE_REQUEST"
    FOLLOW_UP = "FOLLOW_UP"
    CLARIFICATION_REQUIRED = "CLARIFICATION_REQUIRED"
    OUT_OF_SCOPE = "OUT_OF_SCOPE"

class ExtractedEntities(BaseModel):
    test_name: Optional[str] = None
    canonical_name: Optional[str] = None
    year: Optional[int] = None
    month: Optional[int] = None
    date_range: Optional[Dict[str, str]] = None
    granularity: Optional[str] = Field(default=None, description="date, month, or year")
    language: Optional[str] = "english"
    raw_query: str = ""

class IntentClassificationResult(BaseModel):
    intent: IntentType
    confidence: float = Field(ge=0.0, le=1.0)
    entities: ExtractedEntities = Field(default_factory=ExtractedEntities)
    is_ambiguous: bool = False
    clarification_prompt: Optional[str] = None
    suggested_action: Optional[str] = None
