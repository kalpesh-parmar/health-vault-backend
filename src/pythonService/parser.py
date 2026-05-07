import re
date_time_pattern = r"\b(\d{1,2}[\s\-\/]?(Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|September|Oct|October|Nov|November|Dec|December)[\s,\-\/]?\d{2,4}[\s,]*\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM|am|pm)?|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}[\sT]?\d{1,2}:\d{2}(:\d{2})?|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}[\sT]\d{1,2}:\d{2}(:\d{2})?)\b"

def parse_medical_data(text):
    return {
        "hospitalName": extract_hospital(text),
        "doctorName": extract_doctor(text),
        "reportDate": extract_date(text),
        "remarks": extract_conclusion(text),
        "parameters": extract_parameters(text),
        # "rawText": text
    }


def extract_doctor(text):
    match = re.search(r"(?:Dr\.?|DR|Doctor|Physician|Consultant|Ref\.?\s*By)\s*[:\-]?\s*([A-Za-z\s\.]+)",text)
    return match.group(1).strip() if match else None


def extract_hospital(text):
    match = re.search(r"([A-Z][A-Za-z\s]{3,80}(?:Hospital|Clinic|Diagnostics|Lab|Laboratory|Medical Center))",text)
    return match.group(1) if match else None


def extract_date(text):
    match = re.search (date_time_pattern,text)
    return match.group(0) if match else None


def extract_conclusion(text):
    match = re.search(r"(?:Interpretation|Conclusion|Remarks|Notes)\s*[:\-]?\s*(.*?)(?:Thanks|End of Report|Signature|$)", text)
    if match:
        return match.group(1).strip()

    return None
def extract_parameters(text):
    parameters = []

    pattern = re.findall(
        r"([A-Za-z\s\(\)%\-]+?)\s+(\d+\.?\d*)\s*([A-Za-z/%µgdl]*)\s*([0-9\.\-to\s]*)",
        text
    )

    for item in pattern:
        name, value, unit, reference = item

        parameters.append({
            "name": name.strip(),
            "value": value.strip(),
            "unit": unit.strip(),
            "reference": reference.strip()
        })

    return parameters