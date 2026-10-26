import re
from typing import Dict, Any, Optional
from app.modules.chat.intent_schema import (
    IntentType,
    ExtractedEntities,
    IntentClassificationResult
)

CANONICAL_TEST_MAPPING = {
    r"\b(?:fasting\s+(?:blood\s+)?sugar|fbs|fasting\s+glucose)\b": "glucose_fasting",
    r"\b(?:ppbs|post\s*(?:prandial|meal)\s+(?:blood\s+)?sugar|post\s*(?:prandial|meal)\s+glucose)\b": "glucose_postprandial",
    r"\b(?:rbs|random\s+(?:blood\s+)?sugar|random\s+glucose|sugar|glucose)\b": "glucose_random",
    r"\b(?:hba1c|glycated\s+hemoglobin|a1c)\b": "hba1c",
    r"\b(?:hemoglobin|hb)\b": "hemoglobin",
    r"\b(?:creatinine|serum\s+creatinine)\b": "creatinine_serum",
    r"\b(?:tsh|thyroid\s+stimulating\s+hormone|thyroid)\b": "tsh",
    r"\b(?:lipid|cholesterol|total\s+cholesterol)\b": "cholesterol_total",
    r"\b(?:ldl|ldl\s+cholesterol)\b": "cholesterol_ldl",
    r"\b(?:hdl|hdl\s+cholesterol)\b": "cholesterol_hdl",
    r"\b(?:triglycerides|tg)\b": "triglycerides",
    r"\b(?:wbc|white\s+blood\s+cells|leukocytes)\b": "wbc_count",
    r"\b(?:platelets|platelet\s+count)\b": "platelet_count"
}

OUT_OF_SCOPE_PATTERNS = [
    r"\b(?:write\s+(?:python|javascript|code|script)|debug\s+code)\b",
    r"\b(?:capital\s+of|weather\s+in|who\s+won|stock\s+price|president\s+of)\b",
    r"\b(?:ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|you\s+are\s+now)\b",
]

CHART_PATTERNS = [
    r"\b(?:trend|trends|graph|chart|plot|over\s+time|history|progression)\b",
    r"\b(?:compare\s+(?:years|months|dates)|timeline)\b",
]

SUMMARY_PATTERNS = [
    r"\b(?:summary|summarize|overview|saransh|samjhavo|samjhao|batao)\b",
    r"\b(?:report\s+ma\s+su\s+chhe|report\s+samjhao|explain\s+report)\b",
]

TABLE_PATTERNS = [
    r"\b(?:table|tabular|list\s+all\s+(?:results|tests|values)|matrix)\b",
]

COMPARISON_PATTERNS = [
    r"\b(?:compare\s+with|vs|versus|difference\s+between)\b",
]

def extract_canonical_metric(query: str) -> Optional[str]:
    q_lower = query.lower()
    for pattern, canonical in CANONICAL_TEST_MAPPING.items():
        if re.search(pattern, q_lower):
            return canonical
    return None

def extract_year(query: str) -> Optional[int]:
    match = re.search(r"\b(20[12]\d)\b", query)
    if match:
        return int(match.group(1))
    return None

def classify_medical_intent(query: str, session_context: Optional[Dict[str, Any]] = None) -> IntentClassificationResult:
    if not query or not query.strip():
        return IntentClassificationResult(
            intent=IntentType.OUT_OF_SCOPE,
            confidence=1.0,
            suggested_action="reject_empty"
        )
    
    q_lower = query.lower().strip()
    
    # 1. Out of scope / Security containment
    for pattern in OUT_OF_SCOPE_PATTERNS:
        if re.search(pattern, q_lower):
            return IntentClassificationResult(
                intent=IntentType.OUT_OF_SCOPE,
                confidence=0.99,
                suggested_action="deflect_out_of_scope"
            )
            
    canonical_metric = extract_canonical_metric(q_lower)
    year = extract_year(q_lower)
    
    entities = ExtractedEntities(
        canonical_name=canonical_metric,
        year=year,
        granularity="month" if "month" in q_lower else ("year" if year else "date"),
        raw_query=query
    )
    
    # 2. Medical Trend Chart
    for pattern in CHART_PATTERNS:
        if re.search(pattern, q_lower):
            return IntentClassificationResult(
                intent=IntentType.MEDICAL_TREND_CHART,
                confidence=0.95,
                entities=entities,
                suggested_action="generate_chart"
            )
            
    # 3. Document Comparison
    for pattern in COMPARISON_PATTERNS:
        if re.search(pattern, q_lower):
            return IntentClassificationResult(
                intent=IntentType.DOCUMENT_COMPARISON,
                confidence=0.92,
                entities=entities,
                suggested_action="compare_documents"
            )
            
    # 4. Table Request
    for pattern in TABLE_PATTERNS:
        if re.search(pattern, q_lower):
            return IntentClassificationResult(
                intent=IntentType.TABLE_REQUEST,
                confidence=0.95,
                entities=entities,
                suggested_action="render_table"
            )
            
    # 5. Direct Fact Lookup (has canonical metric without chart/summary trigger)
    if canonical_metric and not any(re.search(p, q_lower) for p in SUMMARY_PATTERNS):
        return IntentClassificationResult(
            intent=IntentType.FACT_LOOKUP,
            confidence=0.92,
            entities=entities,
            suggested_action="direct_fact_lookup"
        )
        
    # 6. Document Summary
    for pattern in SUMMARY_PATTERNS:
        if re.search(pattern, q_lower):
            return IntentClassificationResult(
                intent=IntentType.DOCUMENT_SUMMARY,
                confidence=0.93,
                entities=entities,
                suggested_action="fetch_document_summary"
            )
            
    # 7. Contextual Follow-up
    if session_context and session_context.get("active_metric"):
        if re.search(r"\b(?:what\s+about|aur|ani|ane|and|compare)\b", q_lower):
            return IntentClassificationResult(
                intent=IntentType.FOLLOW_UP,
                confidence=0.88,
                entities=entities,
                suggested_action="resolve_followup"
            )
            
    # Default to Medical Explanation
    return IntentClassificationResult(
        intent=IntentType.MEDICAL_EXPLANATION,
        confidence=0.85,
        entities=entities,
        suggested_action="rag_explanation"
    )
