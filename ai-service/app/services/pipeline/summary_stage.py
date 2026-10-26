from __future__ import annotations

import logging
import re
from typing import Any

from app.modules.summary.service import SummaryService
from app.services.translation_service import TranslationService

logger = logging.getLogger(__name__)

# Map common language names or codes to IndicTrans2 language names/codes
SUPPORTED_TRANSLATION_LANGUAGES = {
    "gu": "gujarati",
    "gujarati": "gujarati",
    "hi": "hindi",
    "hindi": "hindi",
    "mr": "marathi",
    "marathi": "marathi",
    "ta": "tamil",
    "tamil": "tamil",
    "te": "telugu",
    "telugu": "telugu",
    "kn": "kannada",
    "kannada": "kannada",
    "bn": "bengali",
    "bengali": "bengali",
    "pa": "punjabi",
    "punjabi": "punjabi",
}

IMAGE_ONLY_DISCLOSURES: dict[str, dict[str, str]] = {
    "x_ray": {
        "en": "X-ray image uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
        "hi": "एक्स-रे छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
        "gu": "એક્સ-રે ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
        "ta": "எக்ஸ்-ரே படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
        "mr": "क्ष-किरण (X-ray) प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    },
    "ct": {
        "en": "CT scan image uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
        "hi": "सीटी स्कैन छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
        "gu": "સીટી સ્કેન ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
        "ta": "சிடி ஸ்கேன் படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
        "mr": "सीटी (CT) स्कॅन प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    },
    "mri": {
        "en": "MRI scan image uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
        "hi": "एमआरआई स्कैन छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
        "gu": "એમઆરઆઈ સ્કેન ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
        "ta": "எம்ஆர்ஐ ஸ்கேன் படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
        "mr": "एमआरआय (MRI) स्कॅन प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    },
    "ultrasound": {
        "en": "Ultrasound sonogram uploaded successfully. No written report text was detected. Please upload the radiologist's report for formal clinical interpretation.",
        "hi": "अल्ट्रासाउंड सोनोग्राम सफलतापूर्वक अपलोड किया गया। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया रेडियोलॉजिस्ट की रिपोर्ट अपलोड करें।",
        "gu": "અલ્ટ્રાસાઉન્ડ સોનોગ્રામ સફળતાપૂર્વક અપલોડ થયું. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને રેડિયોલોજિસ્ટનો રિપોર્ટ અપલોડ કરો.",
        "ta": "அல்ட்ராசவுண்ட் படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான மருத்துவ விளக்கத்திற்கு ரேடியாலஜிஸ்ட்டின் அறிக்கையைப் பதிவேற்றவும்.",
        "mr": "सोनोग्राफी (Ultrasound) प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया रेडिओलॉजिस्टचा अहवाल अपलोड करा.",
    },
    "ecg": {
        "en": "Electrocardiogram (ECG) tracing uploaded successfully. No written report text was detected. Clinical interpretation of ECG rhythm strips requires physician or cardiologist review.",
        "hi": "इलेक्ट्रोकार्डियोग्राम (ईसीजी) ट्रेसिंग सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। ईसीजी ताल के नैदानिक विश्लेषण के लिए चिकित्सक या हृदय रोग विशेषज्ञ की समीक्षा आवश्यक है।",
        "gu": "ઇલેક્ટ્રોકાર્ડિયોગ્રામ (ECG) ટ્રેસિંગ સફળતાપૂર્વક અપલોડ થયું. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ECG રિધમનું તબીબી અર્થઘટન ચિકિત્સક અથવા કાર્ડિયોલોજિસ્ટ દ્વારા જરૂરી છે.",
        "ta": "எலக்ட்ரோ கார்டியோகிராம் (ECG) படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. ஈசிஜி விளக்கத்திற்கு மருத்துவரின் மதிப்பாய்வு தேவை.",
        "mr": "इलेक्ट्रोकार्डिओग्राम (ECG) ट्रेसिंग यशस्वीरित्या अपलोड झाले. कोणताही लिखित अहवाल आढळला नाही. ईसीजी लयीच्या वैद्यकीय विश्लेषणासाठी डॉक्टरांचे पुनरावलोकन आवश्यक आहे.",
    },
    "other_diagnostic_imaging": {
        "en": "Diagnostic medical image uploaded successfully. No written report text was detected. Please upload the official diagnostic report for formal clinical interpretation.",
        "hi": "नैदानिक चिकित्सा छवि सफलतापूर्वक अपलोड की गई। कोई लिखित रिपोर्ट पाठ नहीं मिला। औपचारिक नैदानिक व्याख्या के लिए कृपया आधिकारिक रिपोर्ट अपलोड करें।",
        "gu": "નિદાન તબીબી ઇમેજ સફળતાપૂર્વક અપલોડ થઈ. કોઈ લેખિત રિપોર્ટ લખાણ મળ્યું નથી. ઔપચારિક તબીબી અર્થઘટન માટે કૃપા કરીને અધિકૃત રિપોર્ટ અપલોડ કરો.",
        "ta": "மருத்துவ படம் வெற்றிகரமாக பதிவேற்றப்பட்டது. எழுதப்பட்ட அறிக்கை உரை எதுவும் கண்டறியப்படவில்லை. முறையான விளக்கத்திற்கு அதிகாரப்பூர்வ அறிக்கையைப் பதிவேற்றவும்.",
        "mr": "वैद्यकीय प्रतिमा यशस्वीरित्या अपलोड केली. कोणताही लिखित अहवाल आढळला नाही. औपचारिक वैद्यकीय विश्लेषणासाठी कृपया अधिकृत अहवाल अपलोड करा.",
    },
}


def get_image_only_fallback_disclosure(modality: str, language: str) -> str:
    """Retrieve localized disclosure text for verified image-only medical documents."""
    norm_mod = (modality or "other_diagnostic_imaging").lower().strip()
    norm_lang = (language or "en").lower().strip()
    if norm_lang in ("english", "en"):
        lang_key = "en"
    elif norm_lang in ("hindi", "hi"):
        lang_key = "hi"
    elif norm_lang in ("gujarati", "gu"):
        lang_key = "gu"
    elif norm_lang in ("tamil", "ta"):
        lang_key = "ta"
    elif norm_lang in ("marathi", "mr"):
        lang_key = "mr"
    else:
        lang_key = "en"

    mod_dict = (
        IMAGE_ONLY_DISCLOSURES.get(norm_mod)
        or IMAGE_ONLY_DISCLOSURES.get("other_diagnostic_imaging")
        or IMAGE_ONLY_DISCLOSURES["x_ray"]
    )
    return mod_dict.get(lang_key) or mod_dict["en"]


def build_medgemma_educational_prompt(modality: str) -> str:
    """Constructs a strictly guardrailed prompt for MedGemma vision educational overview."""
    norm_mod = (modality or "diagnostic_imaging").lower().strip()
    if norm_mod in ("ecg", "ekg", "ecg_waveform_strip"):
        return (
            "You are an educational medical imaging assistant. This document image appears to be an electrocardiogram (ECG / EKG) waveform tracing or rhythm strip.\n"
            "Provide a brief, objective, educational visual description of the visible image presentation.\n"
            "SAFETY AND CLINICAL GUARDRAILS (STRICT COMPLIANCE REQUIRED):\n"
            "- You DO NOT have validated clinical ECG rhythm or waveform diagnostic interpretation capabilities.\n"
            "- Describe ONLY the visual presentation (e.g. grid layout, number of visible lead panels/channels, presence of baseline waveform tracings).\n"
            "- DO NOT attempt to diagnose heart rhythms, arrhythmias, ischemia, infarcts, intervals (PR, QRS, QT), axis, or heart rate.\n"
            "- DO NOT provide any clinical interpretation, medical advice, treatment recommendations, or risk evaluations.\n"
            "- Conclude by explicitly stating: 'This is an uninterpreted visual overview. Electrocardiogram waveform analysis requires clinical interpretation by a licensed physician or cardiologist.'"
        )

    modality_name = {
        "x_ray": "X-ray radiograph",
        "ct": "Computed Tomography (CT) scan",
        "mri": "Magnetic Resonance Imaging (MRI) scan",
        "ultrasound": "Ultrasound sonogram",
    }.get(norm_mod, "diagnostic medical scan")

    return (
        f"You are an expert medical imaging AI assistant performing a preliminary visual screening of a {modality_name}.\n"
        "Carefully examine the actual image and provide detailed, objective, structured observations.\n\n"
        "Please structure your response using EXACTLY these headings:\n"
        "ANATOMICAL REGION: Identify the primary anatomical body region shown (e.g. Chest / Thorax, Lumbar Spine, Pelvis, Knee, Hand, Abdomen).\n"
        "IMAGE VIEW: Identify the projection or view (e.g. Frontal / PA, AP, Lateral, Oblique, Axial) and patient orientation.\n"
        "IMAGE QUALITY: Objectively describe technical image characteristics (exposure, contrast, patient positioning, inspiratory effort / lung inflation if chest, rotation, presence of side markers like L/R, or radiographic artifacts).\n"
        "VISIBLE DETAILS: Provide an objective inventory of visible anatomical landmarks and structures according to the body region shown (for chest: ribs, clavicles, thoracic spine, cardiac silhouette, lung fields, costophrenic angles; for extremities: bones, cortex, articular surfaces, joint spaces; for spine: vertebral bodies, alignment, disc spaces; for abdomen/pelvis: pelvic ring, soft tissue outlines, gas patterns).\n"
        "UNCERTAINTY & LIMITATIONS: Note observational limitations (e.g. 2D projection overlap, screening resolution, lack of full DICOM PACS dynamic range, absence of prior comparison films, automated screening nature).\n"
        "PRELIMINARY OBSERVATION SUMMARY: Provide a detailed, cohesive educational description summarizing the visible anatomy and scan characteristics in 2 to 4 clear paragraphs.\n\n"
        "STRICT SAFETY & CLINICAL GUARDRAILS:\n"
        "- DO NOT assert, confirm, or definitively rule out any pathology, fracture, disease, pneumonia, effusion, mass, lesion, or abnormality.\n"
        "- DO NOT declare the scan definitively 'normal' or 'pathology-free' — automated screening cannot replace radiologist diagnosis.\n"
        "- DO NOT assign risk categories, prognostic scores, staging, or medical diagnoses.\n"
        "- DO NOT prescribe medications, dosages, or clinical treatments.\n"
        "- Conclude the summary by stating that this is an unconfirmed preliminary technical screening and formal clinical interpretation requires evaluation by a licensed radiologist or qualified physician."
    )


def validate_medgemma_educational_output(text: str) -> tuple[bool, str]:
    """Strictly validates MedGemma vision output.
    Ensures that unsupported diagnostic claims, prescriptions, or malformed
    artifacts cannot be accepted as educational descriptions.
    """
    if not text or not isinstance(text, str):
        return False, "EMPTY_OR_NON_STRING"

    cleaned = text.strip()
    if len(cleaned) < 20:
        return False, "OUTPUT_TOO_SHORT"
    if len(cleaned) > 4000:
        return False, "OUTPUT_EXCESSIVELY_LONG"

    # Reject raw JSON or markdown code blocks
    if cleaned.startswith(("{", "[")) or re.search(r"```(?:json)?\s*[\{\[]", cleaned):
        return False, "RAW_JSON_OR_CODE_BLOCK"

    # Reject chat/assistant preambles and special tokens
    if re.search(r"^(?:Human|Assistant|User|System)\s*:", cleaned, re.IGNORECASE | re.MULTILINE):
        return False, "CHAT_ROLE_PREAMBLE_LEAKAGE"
    if "<|im_start|>" in cleaned or "<|im_end|>" in cleaned:
        return False, "SPECIAL_TOKEN_LEAKAGE"

    # Guardrail against definitive ungrounded diagnostic claims or false normal assertions
    definitive_diagnosis_patterns = [
        r"\bdiagnos(?:is|ed)\s*:\s*(?!none|unassessed|unconfirmed|deferred|not\s+detected)\w+",
        r"\bconfirmed\s+(?:fracture|infarct|carcinoma|tumor|mass|effusion|pneumonia|covid|hemorrhage|bleed)\b",
        r"\bdefinite\s+(?:pathology|fracture|arrhythmia|cardiomegaly)\b",
        r"\b(?:stage\s+[I|V|X]+|metastasis)\b",
        r"\bconfirmed\s+normal\b",
        r"\bdefinitively?\s+normal\b",
        r"\bentirely\s+normal\s+(?:scan|radiograph|x-ray)\b",
    ]
    for pattern in definitive_diagnosis_patterns:
        if re.search(pattern, cleaned, re.IGNORECASE):
            return False, f"UNSUPPORTED_DIAGNOSTIC_CLAIM: {pattern}"

    # Guardrail against prescription or medication instructions
    prescription_patterns = [
        r"\b\d+(?:\.\d+)?\s*(?:mg|ml|mcg|tablets?|capsules?)\b",
        r"\bprescribed\s+(?!none|not)\w+",
        r"\btake\s+\d+\s+(?:times|tablets?|capsules?|pills?)\b",
        r"\b(?:twice|thrice|once)\s+daily\b",
        r"\bpatient\s+(?:must|should)\s+(?:take|ingest|administer)\b",
    ]
    for pattern in prescription_patterns:
        if re.search(pattern, cleaned, re.IGNORECASE):
            return False, f"UNSUPPORTED_PRESCRIPTION_CLAIM: {pattern}"

    return True, "VALID"


def detect_written_radiology_report(
    text: str,
    structured_data: dict[str, Any] | None = None,
    ocr_pages: list[dict[str, Any]] | None = None,
) -> bool:
    """Accurately detects whether a document contains a genuine written radiology/imaging report.
    Replaces crude word-count cutoffs with clinical heading, structure,
    finding density, and stamp/label exclusion analysis.
    """
    if not text or not isinstance(text, str):
        return False

    clean = text.strip()
    if not clean:
        return False

    if structured_data and (structured_data.get("isNoText") or structured_data.get("is_no_text")):
        return False

    # Check if text consists exclusively of demographic stamps, headers, or orientation markers
    lines = [line.strip() for line in clean.splitlines() if line.strip()]
    stamp_patterns = [
        r"^(?:name|patient\s*name|pt\s*name|age|sex|gender|dob|date|time|id|uhid|mrn|ipd|opd|ref(?:erred)?\s*by|dr\.?|hospital|clinic|center|dept|bed|reg|acc|study\s*date|modality|kvp|mas|sec)\s*[:\-]",
        r"^(?:r|l|pa|ap|lat|lateral|erect|supine|oblique|chest|film\s*no\.?)\.?$",
    ]
    if len(lines) <= 8 and all(any(re.search(p, line, re.IGNORECASE) for p in stamp_patterns) for line in lines):
        return False

    words = clean.split()
    word_count = len(words)
    if word_count < 10:
        return False

    # 1. Authoritative Clinical Report Headings
    report_heading_patterns = [
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:IMPRESSION|IMPRESSIONS|FINAL IMPRESSION|CLINICAL IMPRESSION)\*{0,2}\s*[:\-]",
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:FINDINGS|RADIOLOGICAL FINDINGS|IMAGING FINDINGS|RADIOGRAPHIC FINDINGS|OBSERVATIONS|ULTRASOUND FINDINGS)\*{0,2}\s*[:\-]",
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:TECHNIQUE|PROTOCOL|EXAMINATION|STUDY|CLINICAL INDICATION|CLINICAL HISTORY)\*{0,2}\s*[:\-]",
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:CONCLUSION|CONCLUSIONS|OPINION|INTERPRETATION)\*{0,2}\s*[:\-]",
    ]
    has_report_heading = any(re.search(pat, clean, re.IGNORECASE) for pat in report_heading_patterns)

    # 2. Radiologist Signature / Credential / Department Affiliation
    radiologist_signature_patterns = [
        r"\b(?:consultant\s+)?radiologist\b",
        r"\bdepartment\s+of\s+radiodiagnosis\b",
        r"\bconsultant\s+radiology\b",
        r"\bdr\.?\s+[a-z\s\.\']+(?:\,\s*(?:m\.?d\.?|d\.?n\.?b\.?|d\.?m\.?r\.?d\.?|radiolog(?:ist|y)))\b",
        r"\b(?:reported|verified|signed|authorized)\s+by\s*:\s*dr\.?",
    ]
    has_radiologist_signature = any(re.search(pat, clean, re.IGNORECASE) for pat in radiologist_signature_patterns)

    # 3. Clinical Radiology Diagnostic Statements (Thoracic, MSK/extremities, spine, abdomen, neuro)
    clinical_finding_patterns = [
        # Thoracic findings
        r"\b(?:no\s+acute\s+cardiopulmonary|cardiomegaly|infiltrate|consolidation|pleural\s+effusion|pneumothorax|lungs?\s+are\s+clear|hilar\s+shadows?|costophrenic\s+angles?)\b",
        # Musculoskeletal & Spine findings
        r"\b(?:no\s+(?:acute\s+)?(?:fracture|dislocation)|bony\s+structures?\s+are\s+(?:intact|normal)|cortical\s+margins?\s+(?:are\s+)?(?:smooth|intact)|joint\s+spaces?\s+(?:are\s+)?(?:preserved|normal)|degenerative\s+changes|osteophytes?|vertebral\s+heights?\s+and\s+alignment|soft\s+tissues?\s+are\s+unremarkable)\b",
        # Abdominal, Ultrasound, CT, MRI findings
        r"\b(?:no\s+significant\s+abnormality|visualized\s+portions?\s+of|normal\s+in\s+size\s+and\s+echo\s*texture|within\s+normal\s+limits|no\s+focal\s+lesion|unremarkable\s+study)\b",
    ]
    matching_findings_count = sum(1 for pat in clinical_finding_patterns if re.search(pat, clean, re.IGNORECASE))

    # Evaluate decision criteria:
    # Criterion A: Structured report heading + (clinical finding OR radiologist signature OR word count >= 15)
    if has_report_heading and (matching_findings_count > 0 or has_radiologist_signature or word_count >= 15):
        return True

    # Criterion B: Radiologist signature + at least one clinical finding statement
    if has_radiologist_signature and matching_findings_count > 0:
        return True

    # Criterion C: Multiple independent clinical finding statements (>= 2) even if headers were dropped by OCR
    if matching_findings_count >= 2:
        return True

    # Criterion D: High word count (>= 50 words) that includes at least one clinical finding or radiologist mention
    if word_count >= 50 and (matching_findings_count > 0 or has_radiologist_signature):
        return True

    return False


def parse_medgemma_structured_observations(text: str, modality: str = "x_ray") -> dict[str, Any]:
    """Extracts structured clinical imaging observations from MedGemma output.
    Captures anatomical region, suggested view, image quality, visible details/landmarks,
    and technical uncertainty or limitations without fabricating anatomical assumptions.
    """
    norm_mod = (modality or "x_ray").lower().strip()
    raw = (text or "").strip()

    def _extract_section(patterns: list[str], fallback: str = "") -> str:
        for pat in patterns:
            m = re.search(pat, raw, re.IGNORECASE | re.DOTALL)
            if m:
                val = m.group(1).strip()
                val = re.sub(r"^\*+|\*+$", "", val).strip()
                if val:
                    return val
        return fallback

    # 1. Anatomical Region - Never fabricate Chest / Thorax for unknown images
    anatomical_region = _extract_section([
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:ANATOMICAL REGION|ANATOMY|BODY PART|EXAMINED REGION)\*{0,2}\s*[:\-]\s*(.+?)(?=(?:\n\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:IMAGE VIEW|VIEW|PROJECTION|ORIENTATION|IMAGE QUALITY|TECHNICAL QUALITY|VISIBLE|FINDINGS|OBSERVATIONS|UNCERTAINTY|LIMITATIONS|PRELIMINARY|SUMMARY|CLINICAL))|\Z)",
    ], fallback="Unspecified anatomical region")

    # 2. Suggested View / Projection - Never assume Frontal PA/AP for unknown images
    suggested_view = _extract_section([
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:IMAGE VIEW|SUGGESTED VIEW|VIEW\s*/\s*PROJECTION|PROJECTION|ORIENTATION)\*{0,2}\s*[:\-]\s*(.+?)(?=(?:\n\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:IMAGE QUALITY|TECHNICAL QUALITY|VISIBLE|FINDINGS|OBSERVATIONS|UNCERTAINTY|LIMITATIONS|PRELIMINARY|SUMMARY|CLINICAL))|\Z)",
    ], fallback="Projection / view not determined")

    # 3. Image Quality - Never assume assessed screening quality when absent
    image_quality = _extract_section([
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:IMAGE QUALITY|TECHNICAL QUALITY|SCAN QUALITY|QUALITY)\*{0,2}\s*[:\-]\s*(.+?)(?=(?:\n\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:VISIBLE|FINDINGS|OBSERVATIONS|UNCERTAINTY|LIMITATIONS|PRELIMINARY|SUMMARY|CLINICAL))|\Z)",
    ], fallback="Technical quality not assessed")

    # 4. Visible Details - Never fabricate thoracic/lung structures for non-chest scans
    visible_details = _extract_section([
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:VISIBLE DETAILS|VISIBLE ANATOMICAL STRUCTURES|VISIBLE STRUCTURES|ANATOMICAL FINDINGS|VISIBLE OBSERVATIONS|OBSERVATIONS)\*{0,2}\s*[:\-]\s*(.+?)(?=(?:\n\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:UNCERTAINTY|LIMITATIONS|TECHNICAL LIMITATIONS|PRELIMINARY|SUMMARY|CLINICAL))|\Z)",
    ], fallback="Landmarks not discretely itemized")

    # 5. Uncertainty & Limitations
    uncertainty = _extract_section([
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:UNCERTAINTY & LIMITATIONS|UNCERTAINTY|LIMITATIONS|TECHNICAL LIMITATIONS|OBSERVATIONAL LIMITATIONS)\*{0,2}\s*[:\-]\s*(.+?)(?=(?:\n\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:PRELIMINARY|SUMMARY|CLINICAL NOTICE|CLINICAL DISCLAIMER))|\Z)",
    ], fallback="Preliminary AI visual screening from uploaded image; lacks high-resolution diagnostic DICOM calibration; clinical radiologist review required.")

    # 6. Preliminary Summary
    preliminary_summary = _extract_section([
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:PRELIMINARY OBSERVATION SUMMARY|OBSERVATION SUMMARY|SUMMARY|PRELIMINARY SUMMARY|OVERVIEW)\*{0,2}\s*[:\-]\s*(.+?)(?=(?:\n\s*(?:\d+[\.\)]\s*)?\*{0,2}(?:CLINICAL NOTICE|CLINICAL DISCLAIMER|SAFETY))|\Z)",
    ], fallback="")

    if not preliminary_summary:
        preliminary_summary = raw

    visible_structures: list[str] = []
    if visible_details and visible_details != "Landmarks not discretely itemized":
        for line in visible_details.splitlines():
            clean_line = re.sub(r"^\s*[-*•]\s*", "", line).strip()
            if clean_line:
                visible_structures.append(clean_line)
        if not visible_structures:
            visible_structures = [s.strip() for s in visible_details.split(",") if s.strip()]

    return {
        "anatomicalRegion": anatomical_region,
        "suggestedView": suggested_view,
        "imageQuality": image_quality,
        "visibleDetails": visible_details,
        "visibleStructures": visible_structures,
        "uncertainty": uncertainty,
        "summary": preliminary_summary,
    }


def format_safe_educational_summary(
    observations: dict[str, Any],
    raw_desc: str,
    modality: str = "x_ray",
) -> str:
    """Formats a detailed, professional, structured English summary from MedGemma observations."""
    norm_mod = (modality or "x_ray").lower().strip()
    modality_title = {
        "x_ray": "X-Ray Radiograph",
        "ct": "Computed Tomography (CT) Scan",
        "mri": "Magnetic Resonance Imaging (MRI) Scan",
        "ultrasound": "Ultrasound Sonogram",
        "ecg": "Electrocardiogram (ECG)",
    }.get(norm_mod, "Medical Diagnostic Scan")

    anat = observations.get("anatomicalRegion") or "Unspecified anatomical region"
    view = observations.get("suggestedView") or "Projection / view not determined"
    qual = observations.get("imageQuality") or "Technical quality not assessed"
    vis = observations.get("visibleDetails") or "Landmarks not discretely itemized"
    unc = observations.get("uncertainty") or "Automated preliminary screening; unconfirmed without formal radiologist review."
    summary_para = observations.get("summary", "")

    clean_summary_para = re.sub(
        r"(?:ANATOMICAL REGION|IMAGE VIEW|IMAGE QUALITY|VISIBLE DETAILS|UNCERTAINTY & LIMITATIONS|PRELIMINARY OBSERVATION SUMMARY)\s*[:\-].*?(?=\n|$)",
        "",
        summary_para,
        flags=re.IGNORECASE,
    ).strip()
    if not clean_summary_para:
        if anat != "Unspecified anatomical region" and view != "Projection / view not determined":
            clean_summary_para = f"Preliminary visual examination of the {anat} in {view} projection. Technical image quality: {qual.lower()}."
        else:
            clean_summary_para = f"Preliminary visual screening of the uploaded {modality_title}. Specific anatomical region and projection were not discretely determined by automated analysis."

    summary_md = (
        f"**Preliminary {modality_title} Visual Screening**\n\n"
        f"• **Anatomical Region:** {anat}\n"
        f"• **Suggested Projection / View:** {view}\n"
        f"• **Technical Image Quality:** {qual}\n"
        f"• **Visible Anatomical Landmarks:** {vis}\n"
        f"• **Uncertainty & Technical Limitations:** {unc}\n\n"
        f"**Visual Overview:**\n{clean_summary_para}\n\n"
        f"**Clinical Review Notice:** This preliminary summary is generated by MedGemma 4B for educational and organizational assistance only. It is NOT a confirmed diagnosis, formal radiology report, or proof of normal anatomy. Formal clinical interpretation requires evaluation by a licensed radiologist or qualified physician."
    )
    return summary_md.strip()

CLINICAL_TEST_ALIASES: dict[str, list[str]] = {
    "patients value (pt)": ["pt", "prothrombin", "prothrombin time"],
    "patient value (aptt)": ["aptt", "thromboplastin", "partial thromboplastin"],
    "random blood sugar": ["random blood sugar", "rbs", "blood sugar", "glucose"],
    "fasting blood sugar": ["fasting blood sugar", "fbs", "glucose"],
    "post prandial blood sugar": ["ppbs", "post prandial", "glucose"],
    "hba1c": ["hba1c", "a1c", "glycated hemoglobin"],
    "hematocrit/pcv": ["hematocrit", "pcv", "packed cell volume"],
    "rbc count": ["rbc", "red blood cell", "red blood cells", "erythrocyte"],
    "wbc count": ["wbc", "white blood cell", "white blood cells", "leukocyte"],
    "platelet count": ["platelet", "platelets", "thrombocyte"],
    "rdw-cv": ["rdw", "red cell distribution"],
    "hemoglobin": ["hemoglobin", "haemoglobin", "hb"],
}


def strip_think_tokens(text: str) -> str:
    """Strips <think>, <thinking>, <reasoning> reasoning traces and unclosed think tags (HF-1 compliance)."""
    if not text:
        return ""
    cleaned = re.sub(r"<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?</(?:think|thinking|reasoning)>", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*$", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def is_abnormal_or_borderline(item: dict[str, Any]) -> bool:
    """Returns True if a lab parameter is clinically abnormal or borderline."""
    if item.get("is_informational") or item.get("status") == "info":
        return False
    st = str(item.get("status") or "").lower()
    sev = str(item.get("severity") or "").lower()
    flag = str(item.get("flag") or "").upper()

    if sev in ("borderline", "mild", "significant"):
        return True
    if st in ("low", "high", "abnormal", "borderline", "diabetic", "prediabetic"):
        return True
    if flag in ("LOW", "HIGH", "CRITICAL", "DIABETIC", "PREDIABETIC"):
        return True
    if item.get("isAbnormal") is True:
        return True
    return False


def build_deterministic_key_findings(structured_data: dict[str, Any]) -> list[dict[str, Any]]:
    """Builds deterministic key findings strictly in code from abnormal and borderline parameters."""
    raw_labs = structured_data.get("labResults") or []
    if not raw_labs and "groupedLabResults" in structured_data:
        for sec in structured_data.get("groupedLabResults", []):
            raw_labs.extend(sec.get("items") or [])

    seen_tests = set()
    findings: list[dict[str, Any]] = []

    for item in raw_labs:
        if not is_abnormal_or_borderline(item):
            continue

        name = (item.get("testName") or item.get("name") or "").strip()
        if not name or name.lower() in seen_tests:
            continue
        seen_tests.add(name.lower())

        val = item.get("value")
        unit = item.get("unit") or ""
        st = item.get("status") or item.get("computed_status") or "abnormal"
        sev = item.get("severity")
        ref = item.get("referenceRange") or item.get("reference_raw") or ""

        sev_desc = f", {sev} severity" if sev else ""
        ref_desc = f" (Ref: {ref})" if ref else ""
        finding_text = f"{name} is {val} {unit} [{st}{sev_desc}]{ref_desc}".strip()

        findings.append({
            "testName": name,
            "name": name,
            "value": val,
            "unit": unit,
            "status": st,
            "severity": sev,
            "referenceRange": ref,
            "finding": finding_text,
        })

    return findings


def format_abnormal_findings_prompt(key_findings: list[dict[str, Any]]) -> str:
    """Formats explicit abnormal test list with value, unit, status, severity, range."""
    if not key_findings:
        return ""
    lines = []
    for f in key_findings:
        name = f.get("testName") or f.get("name")
        val = f.get("value")
        unit = f.get("unit") or ""
        st = f.get("status")
        sev = f.get("severity") or "standard"
        ref = f.get("referenceRange") or "N/A"
        lines.append(f"- {name}: value={val} {unit}, status={st}, severity={sev}, range={ref}")

    items_str = "\n".join(lines)
    return (
        f"The following tests are abnormal:\n"
        f"{items_str}\n"
        f"Your summary MUST explain each of these."
    )


def verify_abnormal_parameters_present(
    key_findings: list[dict[str, Any]],
    summary_text: str,
) -> tuple[bool, list[str]]:
    """Verifies that all abnormal parameters are explained in the summary text."""
    if not key_findings:
        return True, []
    if not summary_text:
        return False, [f.get("testName") or f.get("name") for f in key_findings]

    norm_text = summary_text.lower()
    missing: list[str] = []

    for f in key_findings:
        test_name = (f.get("testName") or f.get("name") or "").strip()
        if not test_name:
            continue
        norm_name = test_name.lower()

        # 1. Exact / direct substring match
        if norm_name in norm_text:
            continue

        # 2. Check aliases and sub-tokens
        aliases = list(CLINICAL_TEST_ALIASES.get(norm_name, []))

        # Parenthetical parts e.g. "Patients Value (PT)" -> "patients value", "pt"
        m_paren = re.search(r"^(.*?)\s*\((.*?)\)", norm_name)
        if m_paren:
            p1, p2 = m_paren.group(1).strip(), m_paren.group(2).strip()
            if p1:
                aliases.append(p1)
            if p2:
                aliases.append(p2)

        # Slashes e.g. "Hematocrit/PCV" -> "hematocrit", "pcv"
        if "/" in norm_name:
            for part in norm_name.split("/"):
                if part.strip():
                    aliases.append(part.strip())

        # Hyphens e.g. "RDW-CV" -> "rdw"
        if "-" in norm_name:
            for part in norm_name.split("-"):
                if part.strip():
                    aliases.append(part.strip())

        # Trailing "count" e.g. "RBC Count" -> "rbc"
        if norm_name.endswith(" count"):
            aliases.append(norm_name[:-6].strip())

        matched = False
        for alias in aliases:
            alias = alias.strip()
            if not alias:
                continue
            if len(alias) <= 3:
                if re.search(r"\b" + re.escape(alias) + r"\b", norm_text):
                    matched = True
                    break
            else:
                if alias in norm_text or re.search(r"\b" + re.escape(alias), norm_text):
                    matched = True
                    break

        if not matched:
            missing.append(test_name)

    return len(missing) == 0, missing


def extract_key_bullet_points(
    text: str,
    structured_data: dict[str, Any],
    limit: int = 5,
    key_findings: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Extracts high-priority clinical bullet points preserving exact dosages and findings."""
    points: list[str] = []

    # 1. Add diagnoses
    for diag in (structured_data.get("diagnosis") or []):
        d_str = f"Diagnosis: {diag}"
        if d_str not in points:
            points.append(d_str)

    # 2. Add medications with exact dosages
    for med in (structured_data.get("medications") or []):
        m_name = med.get("name") or ""
        m_freq = med.get("frequency") or ""
        if m_name:
            m_str = f"Medication: {m_name} ({m_freq})".strip()
            if m_str not in points:
                points.append(m_str)

    # 3. Add critical or abnormal labs from deterministic key findings
    findings_to_use = key_findings if key_findings is not None else build_deterministic_key_findings(structured_data)
    for f in findings_to_use:
        t_name = f.get("testName") or f.get("name")
        val = f.get("value")
        unit = f.get("unit") or ""
        st = f.get("status")
        ref = f.get("referenceRange") or ""
        l_str = f"Alert: {t_name} is {val} {unit} [{st}] (Ref: {ref})".strip()
        if l_str not in points:
            points.append(l_str)

    # 4. If few points, extract from text sentences
    if len(points) < limit and text:
        for sentence in text.splitlines():
            s_clean = sentence.strip().lstrip("*-• ")
            if len(s_clean) > 20 and not any(p in s_clean for p in points):
                points.append(s_clean)
            if len(points) >= limit:
                break

    return points[:limit]


def summary_is_sane(
    cand_summary: str,
    structured_data: dict[str, Any],
    key_findings: list[dict[str, Any]] | None = None,
) -> bool:
    """Clinical sanity gate for summary outputs.

    Rejects:
    1. Stringified dictionaries/JSON, e.g. "{'type': ..." or "{'summary': ..."
    2. Blatant clinical contradictions, such as claiming 'APTT is high' when APTT
       in structured lab results is clinically normal.
    """
    if not cand_summary or not isinstance(cand_summary, str):
        return False
    cand_clean = cand_summary.strip()
    if not cand_clean:
        return False

    # 1. Reject serialized dict/JSON structures
    if "{'type'" in cand_clean or '{"type"' in cand_clean or "{'summary'" in cand_clean or '{"summary"' in cand_clean:
        return False
    if cand_clean.startswith(("{", "[")) and (": " in cand_clean or ":'" in cand_clean or ':"' in cand_clean):
        return False

    cand_lower = cand_clean.lower()

    # 2. Check for APTT contradiction (claiming APTT is high/elevated when APTT is normal)
    lab_results = structured_data.get("labResults") or []
    aptt_is_normal = False
    for r in lab_results:
        t_name = str(r.get("testName", "")).lower()
        if "aptt" in t_name or "partial thromboplastin" in t_name:
            st = str(r.get("status", "")).lower()
            is_abnormal = bool(r.get("isAbnormal", False))
            if st in ("normal", "within normal limits", "optimal") or (st not in ("high", "elevated", "low") and not is_abnormal):
                aptt_is_normal = True
                break

    if aptt_is_normal:
        high_pat1 = re.search(r"\baptt\b[^.,;:!?\n]{0,30}\b(?:is\s+)?(?:high|elevated|prolonged|increased|abnormal)\b", cand_lower)
        high_pat2 = re.search(r"\b(?:high|elevated|prolonged|increased)\s+[^.,;:!?\n]{0,20}\baptt\b", cand_lower)
        if high_pat1 or high_pat2:
            return False

    return True


class SummaryStageHandler:
    """Stage 8: SUMMARIZING.
    Synthesizes clinical summaries grounded in deterministic code statuses,
    strips <think> tokens, verifies parameter coverage, and guarantees dosage preservation.
    Also handles verified image-only diagnostic scans via MedGemma multimodal vision description.
    """

    def __init__(
        self,
        summary_service: SummaryService | None = None,
        translation_service: TranslationService | None = None,
        llm_service: Any = None,
        medgemma_model: str = "medgemma:4b",
    ) -> None:
        self.summary = summary_service
        self.translation = translation_service
        self.llm = llm_service or (getattr(summary_service, "llm", None) if summary_service else None)
        self.medgemma_model = medgemma_model

    async def generate_image_description(
        self,
        *,
        image_bytes: bytes,
        mime_type: str = "image/jpeg",
        modality: str = "x_ray",
        page_num: int = 1,
    ) -> tuple[str | None, str, dict[str, Any]]:
        """Invokes MedGemma vision with strict educational guardrails.
        Returns (description_text, model_name, image_analysis_dict).
        """
        if not self.llm:
            logger.warning("generate_image_description: LLM service is not configured")
            return None, "none", {
                "status": "UNAVAILABLE",
                "modality": modality,
                "page": page_num,
                "error": "LLM service not configured",
                "clinicallyAssessed": False,
                "requiresClinicianReview": True,
                "hasWrittenReport": False,
            }

        prompt = build_medgemma_educational_prompt(modality)
        try:
            logger.info(
                "Requesting MedGemma educational description for image (modality=%s, model=%s, page=%d)",
                modality,
                self.medgemma_model,
                page_num,
            )
            print("\n========== MEDGEMMA REQUEST ==========")
            print(f"Model: {self.medgemma_model}")
            print(f"Data: {image_bytes}")
            print(f"MIME Type: {mime_type}")
            print(f"Prompt: {prompt}")
            print(f"Temperature: 0.1")
            print("======================================\n")

            raw_desc = await self.llm.describe_image(
                model=self.medgemma_model,
                data=image_bytes,
                mime_type=mime_type,
                prompt=prompt,
                temperature=0.1,
            )

            print("\n========== MEDGEMMA RESPONSE ==========")
            print(raw_desc)
            print("=======================================\n")
            
            clean_desc = strip_think_tokens(raw_desc or "").strip()
            is_valid, validation_reason = validate_medgemma_educational_output(clean_desc)
            if not is_valid:
                logger.warning(
                    "MedGemma output rejected for page %d: %s (snippet: %s)",
                    page_num,
                    validation_reason,
                    clean_desc[:80] if clean_desc else "EMPTY",
                )
                image_analysis = {
                    "status": "REJECTED_UNSAFE_OR_MALFORMED",
                    "modality": modality,
                    "page": page_num,
                    "rejectionReason": validation_reason,
                    "educationalDescription": None,
                    "clinicallyAssessed": False,
                    "requiresClinicianReview": True,
                    "hasWrittenReport": False,
                    "model": self.medgemma_model,
                }
                return None, self.medgemma_model, image_analysis

            observations = parse_medgemma_structured_observations(clean_desc, modality)
            detailed_summary = format_safe_educational_summary(observations, clean_desc, modality)

            image_analysis = {
                "status": "UNVERIFIED_PRELIMINARY",
                "reviewStatus": "PENDING_CLINICIAN_REVIEW",
                "riskLevel": "NOT_ASSESSED",
                "modality": modality,
                "page": page_num,
                "anatomicalRegion": observations.get("anatomicalRegion"),
                "suggestedView": observations.get("suggestedView"),
                "imageQuality": observations.get("imageQuality"),
                "visibleDetails": observations.get("visibleDetails"),
                "visibleStructures": observations.get("visibleStructures"),
                "uncertainty": observations.get("uncertainty"),
                "rawVisualDescription": clean_desc,
                "educationalDescription": detailed_summary,
                "aiGeneratedDescription": detailed_summary,
                "clinicallyAssessed": False,
                "clinicallyAnalyzed": False,
                "requiresClinicianReview": True,
                "hasWrittenReport": False,
                "model": self.medgemma_model,
                "modelProvenance": self.medgemma_model,
            }
            logger.info("MedGemma image description completed successfully for page %d (chars=%d)", page_num, len(detailed_summary))
            return detailed_summary, self.medgemma_model, image_analysis
        except Exception as exc:
            logger.warning("MedGemma image description failed or unavailable for page %d: %s", page_num, exc)
            image_analysis = {
                "status": "FAILED",
                "reviewStatus": "PENDING_CLINICIAN_REVIEW",
                "riskLevel": "NOT_ASSESSED",
                "modality": modality,
                "page": page_num,
                "error": str(exc),
                "educationalDescription": None,
                "aiGeneratedDescription": None,
                "clinicallyAssessed": False,
                "clinicallyAnalyzed": False,
                "requiresClinicianReview": True,
                "hasWrittenReport": False,
            }
            return None, "none", image_analysis

    async def generate_summary(
        self,
        raw_text: str,
        structured_data: dict[str, Any],
        preferred_language: str = "english",
        image_bytes: bytes | None = None,
        mime_type: str = "image/jpeg",
        modality: str | None = None,
        image_pages: list[tuple[int, bytes, str]] | None = None,
        image_source: str | None = None,
        ocr_pages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        logger.info("Generating clinical summary (preferredLanguage=%s)...", preferred_language)

        norm_pref_lang = (preferred_language or "english").lower().strip()
        canonical_lang = SUPPORTED_TRANSLATION_LANGUAGES.get(norm_pref_lang, norm_pref_lang)

        has_images = bool((image_pages and len(image_pages) > 0) or image_bytes)
        image_analysis: dict[str, Any] | None = None

        has_written_report = detect_written_radiology_report(raw_text, structured_data, ocr_pages)

        eff_modality = (
            modality
            or (structured_data.get("documentInfo") or {}).get("modality")
            or structured_data.get("modality")
            or "x_ray"
        )

        if has_images:
            # Build list of image pages to process (handles multi-page imaging PDFs)
            pages_to_process: list[tuple[int, bytes, str]] = []
            if image_pages and len(image_pages) > 0:
                pages_to_process = image_pages
            elif image_bytes:
                pages_to_process = [(1, image_bytes, mime_type)]

            valid_descriptions: list[tuple[int, str]] = []
            page_analyses: list[dict[str, Any]] = []

            for p_num, p_bytes, p_mime in pages_to_process:
                p_desc, p_model, p_analysis = await self.generate_image_description(
                    image_bytes=p_bytes,
                    mime_type=p_mime,
                    modality=eff_modality,
                    page_num=p_num,
                )
                page_analyses.append(p_analysis)
                if p_desc:
                    valid_descriptions.append((p_num, p_desc))

            if valid_descriptions:
                if len(valid_descriptions) == 1:
                    educational_summary = valid_descriptions[0][1]
                else:
                    educational_summary = "\n\n".join(
                        f"Page {p_num}:\n{desc}" for p_num, desc in valid_descriptions
                    )
                image_status = "UNVERIFIED_PRELIMINARY"
            else:
                educational_summary = None
                image_status = "FALLBACK_DISCLOSURE"

            primary_obs: dict[str, Any] = {}
            for pa in page_analyses:
                if pa.get("status") == "UNVERIFIED_PRELIMINARY":
                    primary_obs = pa
                    break
            if not primary_obs and page_analyses:
                primary_obs = page_analyses[0]

            image_analysis = {
                "status": image_status,
                "reviewStatus": "PENDING_CLINICIAN_REVIEW",
                "riskLevel": "NOT_ASSESSED",
                "modality": eff_modality,
                "imageSource": image_source or "authorized_upload",
                "anatomicalRegion": primary_obs.get("anatomicalRegion") or "Unspecified anatomical region",
                "suggestedView": primary_obs.get("suggestedView") or "Projection / view not determined",
                "imageQuality": primary_obs.get("imageQuality") or "Technical quality not assessed",
                "visibleDetails": primary_obs.get("visibleDetails") or "",
                "visibleStructures": primary_obs.get("visibleStructures") or [],
                "uncertainty": primary_obs.get("uncertainty") or "Automated preliminary screening; unconfirmed without formal radiologist review.",
                "aiGeneratedDescription": educational_summary,
                "educationalDescription": educational_summary,
                "model": self.medgemma_model,
                "modelProvenance": self.medgemma_model if image_status == "UNVERIFIED_PRELIMINARY" else "none",
                "totalPages": len(pages_to_process),
                "analyzedPages": [p[0] for p in valid_descriptions],
                "pageAnalyses": page_analyses,
                "clinicallyAssessed": False,
                "clinicallyAnalyzed": False,
                "requiresClinicianReview": True,
                "hasWrittenReport": has_written_report,
                "hasDiagnosticImage": True,
            }

            # If there is no formal written report, the clinical summary is driven by MedGemma's educational description
            if not has_written_report:
                translation_status = "SUCCESS"
                if educational_summary:
                    english_summary = educational_summary
                    
                    # Incorporate OCR labels/markings if present (Image with labels scenario)
                    clean_text = (raw_text or "").strip()
                    if clean_text:
                        label_lines = [l.strip() for l in clean_text.splitlines() if l.strip()]
                        if label_lines:
                            formatted_labels = "\n".join(f"• {l}" for l in label_lines[:8])
                            english_summary = (
                                f"{educational_summary}\n\n"
                                f"**Visible Image Text & Markings (from OCR):**\n"
                                f"{formatted_labels}"
                            )

                    translation_provider = "medgemma_vision"
                    summary_in_pref = english_summary
                    if norm_pref_lang not in ("english", "en") and self.translation:
                        try:
                            translated = await self.translation.translate(
                                text=english_summary,
                                source_language="english",
                                target_language=norm_pref_lang,
                            )
                            if translated and translated.strip():
                                summary_in_pref = translated.strip()
                                translation_provider = "indictrans2"
                        except Exception as t_err:
                            logger.warning("Failed to translate MedGemma visual description: %s", t_err)
                            summary_in_pref = None
                            translation_provider = "medgemma_vision"
                            translation_status = "TRANSLATION_FAILED"
                else:
                    english_summary = get_image_only_fallback_disclosure(eff_modality, "english")
                    summary_in_pref = get_image_only_fallback_disclosure(eff_modality, norm_pref_lang)
                    translation_provider = "deterministic_disclosure"
                    translation_status = "FALLBACK_DISCLOSURE"

                is_trans_ok = (
                    translation_status in ("SUCCESS", "FALLBACK_DISCLOSURE")
                    and summary_in_pref
                    and summary_in_pref != english_summary
                )
                summary_lang = canonical_lang if is_trans_ok else "english"
                summaries_by_lang: dict[str, str] = {
                    "english": english_summary,
                    "en": english_summary,
                }
                if is_trans_ok and summary_in_pref:
                    summaries_by_lang[canonical_lang] = summary_in_pref
                    reverse_code_map = {"gujarati": "gu", "hindi": "hi", "tamil": "ta", "marathi": "mr"}
                    short_code = reverse_code_map.get(canonical_lang)
                    if short_code:
                        summaries_by_lang[short_code] = summary_in_pref

                return {
                    "summaryEnglish": english_summary,
                    "summaryInPreferredLanguage": summary_in_pref if (is_trans_ok or canonical_lang in ("english", "en")) else None,
                    "summaryLanguage": summary_lang,
                    "preferredLanguage": canonical_lang,
                    "summariesByLanguage": summaries_by_lang,
                    "translationStatus": translation_status,
                    "translationProvider": translation_provider,
                    "keyPoints": [english_summary],
                    "keyFindings": [],
                    "key_findings": [],
                    "dosagePreserved": True,
                    "imageAnalysis": image_analysis,
                    "summaryPipelineVersion": "1.1.0",
                }
        else:
            # Written report only (no diagnostic image pages to analyze)
            if has_written_report:
                image_analysis = {
                    "status": "WRITTEN_REPORT_ONLY",
                    "reviewStatus": "CLINICIAN_REPORTED",
                    "riskLevel": "NOT_ASSESSED",
                    "modality": eff_modality,
                    "imageSource": image_source or "authorized_upload",
                    "hasWrittenReport": True,
                    "hasDiagnosticImage": False,
                    "requiresClinicianReview": False,
                    "notice": "Formal written radiologist report summarized. Original diagnostic imaging scans were not included in this document.",
                }

        # 1. Deterministic key findings
        key_findings = build_deterministic_key_findings(structured_data)
        abnormal_prompt = format_abnormal_findings_prompt(key_findings)

        # 2. Synthesize grounded English clinical summary
        english_summary = ""
        if self.summary:
            try:
                # Attempt 1
                try:
                    res = await self.summary.summarize(
                        raw_text,
                        mode="concise",
                        document_type="medical",
                        abnormal_findings=abnormal_prompt,
                    )
                except TypeError:
                    combined_text = f"{abnormal_prompt}\n\n{raw_text}" if abnormal_prompt else raw_text
                    res = await self.summary.summarize(
                        combined_text,
                        mode="concise",
                        document_type="medical",
                    )
                summary_items = res.get("summary") or []
                if summary_items:
                    cand_summary = strip_think_tokens(" ".join(summary_items))
                    is_valid, missing = verify_abnormal_parameters_present(key_findings, cand_summary)
                    is_sane = summary_is_sane(cand_summary, structured_data, key_findings=key_findings)
                    if is_valid and is_sane:
                        english_summary = cand_summary
                    else:
                        logger.warning(
                            "Summary rejected (valid=%s, sane=%s, missing=%s). Retrying once with strict prompt...",
                            is_valid,
                            is_sane,
                            missing,
                        )
                        retry_instruction = (
                            f"RETRY INSTRUCTION: Your previous summary omitted the following abnormal tests: {', '.join(missing)}.\n"
                            f"{abnormal_prompt}\n"
                            f"You MUST explain each of these abnormal tests in your summary."
                        )
                        try:
                            retry_res = await self.summary.summarize(
                                raw_text,
                                mode="concise",
                                document_type="medical",
                                abnormal_findings=retry_instruction,
                            )
                        except TypeError:
                            retry_combined = f"{retry_instruction}\n\n{raw_text}"
                            retry_res = await self.summary.summarize(
                                retry_combined,
                                mode="concise",
                                document_type="medical",
                            )
                        retry_items = retry_res.get("summary") or []
                        if retry_items:
                            retry_cand = strip_think_tokens(" ".join(retry_items))
                            is_retry_valid, retry_missing = verify_abnormal_parameters_present(key_findings, retry_cand)
                            is_retry_sane = summary_is_sane(retry_cand, structured_data, key_findings=key_findings)
                            if is_retry_valid and is_retry_sane:
                                english_summary = retry_cand
                            else:
                                logger.warning(
                                    "Summary rejected after retry (valid=%s, sane=%s, missing=%s). Falling back to deterministic structured summary.",
                                    is_retry_valid,
                                    is_retry_sane,
                                    retry_missing,
                                )
                                english_summary = self._fallback_clinical_summary(raw_text, structured_data, key_findings=key_findings)
                        else:
                            english_summary = self._fallback_clinical_summary(raw_text, structured_data, key_findings=key_findings)
            except Exception as e:
                model_name = getattr(self.summary, "model", None)
                logger.warning(
                    "AI summary service failed, falling back to clinical rule-based summary: model=%s, error_type=%s, error=%s",
                    model_name,
                    type(e).__name__,
                    str(e),
                    extra={"model": model_name, "error_type": type(e).__name__, "error": str(e)},
                )

        if not english_summary or not summary_is_sane(english_summary, structured_data, key_findings=key_findings):
            english_summary = self._fallback_clinical_summary(raw_text, structured_data, key_findings=key_findings)

        # HF-1: Strip any <think> reasoning tokens
        english_summary = strip_think_tokens(english_summary)

        # 3. Extract key points
        key_points = extract_key_bullet_points(english_summary, structured_data, key_findings=key_findings)

        # 4. Translate to preferred language if non-English
        summary_preferred = english_summary
        summary_language = "english"
        translation_status = "SUCCESS" if canonical_lang in ("english", "en") else "FAILED"
        translation_provider = "none"

        if canonical_lang not in ("english", "en"):
            if self.translation and getattr(self.translation, "is_warm", False):
                try:
                    translated = await self.translation.translate(
                        text=english_summary,
                        src_lang="english",
                        tgt_lang=canonical_lang,
                    )
                    meta = getattr(self.translation, "last_metadata", None)
                    if isinstance(meta, dict) and meta.get("status"):
                        if meta.get("status") == "SUCCESS":
                            summary_preferred = meta.get("translated_text") or translated
                            summary_language = canonical_lang
                            translation_status = "SUCCESS"
                            translation_provider = meta.get("provider", "none")
                        else:
                            summary_preferred = None
                            summary_language = "english"
                            translation_status = "TRANSLATION_FAILED"
                            translation_provider = meta.get("provider", "none")
                            logger.warning(
                                "Translation to %s did not succeed (%s: %s).",
                                canonical_lang,
                                translation_status,
                                meta.get("error"),
                            )
                    else:
                        if translated and translated.strip():
                            summary_preferred = strip_think_tokens(translated)
                            summary_language = canonical_lang
                            translation_status = "SUCCESS"
                            translation_provider = "indictrans2"
                        else:
                            summary_preferred = None
                            summary_language = "english"
                            translation_status = "TRANSLATION_FAILED"
                            translation_provider = "none"
                except Exception as e:
                    logger.warning("Translation to %s failed: %s.", canonical_lang, e)
                    summary_preferred = None
                    summary_language = "english"
                    translation_status = "TRANSLATION_FAILED"
                    translation_provider = "none"
            else:
                summary_preferred = None
                summary_language = "english"
                translation_status = "TRANSLATION_FAILED"
                translation_provider = "none"

        is_trans_ok = (
            translation_status == "SUCCESS"
            and summary_preferred
            and summary_preferred != english_summary
        )

        # Verify numerical dosage preservation
        dosages_in_english = re.findall(r"\b\d+(?:\.\d+)?\s*(?:mg|ml|gm|mcg|iu|%)\b", english_summary, re.IGNORECASE)
        dosages_preserved = True
        if dosages_in_english and is_trans_ok and summary_preferred:
            # Check whether numbers are preserved in the translated string
            for d in dosages_in_english:
                num_only = re.search(r"\d+", d).group(0)
                if num_only not in summary_preferred:
                    dosages_preserved = False
                    break

        logger.info(
            "Summary generated successfully: english_chars=%d, preferred_chars=%d, key_points=%d, key_findings=%d, lang=%s, status=%s, provider=%s",
            len(english_summary),
            len(summary_preferred or ""),
            len(key_points),
            len(key_findings),
            summary_language,
            translation_status,
            translation_provider,
        )

        summaries_by_lang: dict[str, str] = {
            "english": english_summary,
            "en": english_summary,
        }
        if is_trans_ok and summary_preferred:
            summaries_by_lang[canonical_lang] = summary_preferred
            reverse_code_map = {"gujarati": "gu", "hindi": "hi", "tamil": "ta", "marathi": "mr"}
            short_code = reverse_code_map.get(canonical_lang)
            if short_code:
                summaries_by_lang[short_code] = summary_preferred

        res_summary = {
            "summaryEnglish": english_summary,
            "summaryInPreferredLanguage": summary_preferred if is_trans_ok else (english_summary if canonical_lang in ("english", "en") else None),
            "summaryLanguage": canonical_lang if is_trans_ok else "english",
            "preferredLanguage": canonical_lang,
            "summariesByLanguage": summaries_by_lang,
            "translationStatus": translation_status,
            "translationProvider": translation_provider,
            "keyPoints": key_points,
            "keyFindings": key_findings,
            "key_findings": key_findings,
            "dosagePreserved": dosages_preserved,
            "summaryPipelineVersion": "1.1.0",
        }
        if image_analysis is not None:
            res_summary["imageAnalysis"] = image_analysis
        return res_summary

    def _fallback_clinical_summary(
        self,
        raw_text: str,
        structured_data: dict[str, Any],
        key_findings: list[dict[str, Any]] | None = None,
    ) -> str:
        parts: list[str] = []
        pt = structured_data.get("patientInfo", {}).get("name")
        doc = structured_data.get("doctorInfo", {}).get("name")
        hosp = structured_data.get("hospitalInfo", {}).get("name")

        if hosp or doc:
            intro = f"Medical record from {hosp or 'hospital'}"
            if doc:
                intro += f" consulted by {doc}"
            parts.append(intro + ".")

        diags = structured_data.get("diagnosis") or []
        if diags:
            parts.append(f"Diagnosis noted: {', '.join(diags)}.")

        meds = structured_data.get("medications") or []
        if meds:
            med_list = [f"{m.get('name', 'Medicine')} ({m.get('frequency', 'as prescribed')})" for m in meds[:4]]
            parts.append(f"Prescribed medications include: {', '.join(med_list)}.")

        findings_to_use = key_findings if key_findings is not None else build_deterministic_key_findings(structured_data)
        if findings_to_use:
            ab_list = []
            for f in findings_to_use:
                name = f.get("testName") or f.get("name")
                val = f.get("value")
                unit = f.get("unit") or ""
                st = f.get("status")
                sev = f.get("severity")
                ref = f.get("referenceRange") or f.get("reference_raw")
                sev_desc = f", {sev} severity" if sev else ""
                ref_desc = f" (Ref: {ref})" if ref else ""
                ab_list.append(f"{name} is {val} {unit} [{st}{sev_desc}]{ref_desc}".strip())
            parts.append(f"Notable lab findings: {'; '.join(ab_list)}.")
        else:
            labs = structured_data.get("labResults") or []
            abnormal = [l for l in labs if l.get("flag") in ("HIGH", "LOW", "CRITICAL", "diabetic", "prediabetic")]
            if abnormal:
                ab_list = [f"{l.get('testName')} ({l.get('value')} {l.get('unit')})" for l in abnormal[:3]]
                parts.append(f"Notable lab findings: {', '.join(ab_list)}.")

        if not parts and raw_text:
            sentences = [s.strip() for s in raw_text.splitlines() if len(s.strip()) > 30]
            parts.append(" ".join(sentences[:3]))

        return " ".join(parts).strip() or "Medical document reviewed. No critical acute findings noted."

