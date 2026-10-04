#!/usr/bin/env python3
"""
Generate realistic synthetic scanned clinical documents for Indic languages (hi, mr, ta, gu)
and isolated rotation ablation suite (0°, 5°, 15°, 45°).

Enforces:
1. Complex script shaping check (PIL.features.check('raqm') and Nirmala/Noto TrueType fonts).
2. Deterministic seeds for reproducibility.
3. Realistic scanner aesthetics (off-white paper, headers, grid tables, subtle noise).
4. Synchronized ground-truth JSON with split: 'synthetic', status: 'synthetic_directional_only'.
"""

import hashlib
import json
import math
import os
import random
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

# Pre-flight text shaping check
if not features.check("raqm"):
    raise RuntimeError("PIL.features.check('raqm') is False. Raqm is required for Indic complex text shaping.")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
FIXTURES_DIR = SCRIPT_DIR.parent / "tests" / "fixtures" / "golden_scanned"
MANIFEST_PATH = FIXTURES_DIR / "manifest.json"

# Resolve font
FONT_CANDIDATES = [
    "C:/Windows/Fonts/Nirmala.ttc",
    "C:/Windows/Fonts/NirmalaB.ttc",
    "C:/Windows/Fonts/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
]
FONT_PATH = None
for candidate in FONT_CANDIDATES:
    if os.path.exists(candidate):
        FONT_PATH = candidate
        break

if not FONT_PATH:
    raise FileNotFoundError("Could not find Nirmala or Noto font for Indic rendering.")


def get_font(size: int, bold: bool = False):
    return ImageFont.truetype(FONT_PATH, size)


def create_paper_canvas(width: int = 1600, height: int = 2200, seed: int = 42) -> Image.Image:
    """Create realistic off-white paper canvas with subtle texture."""
    random.seed(seed)
    np.random.seed(seed)

    # Base paper color (slight warm cream off-white)
    base_r = random.randint(248, 252)
    base_g = random.randint(247, 251)
    base_b = random.randint(243, 247)

    arr = np.full((height, width, 3), [base_r, base_g, base_b], dtype=np.uint8)

    # Add very faint scanner noise
    noise = np.random.normal(0, 1.2, (height, width, 3))
    arr = np.clip(arr.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def apply_scanner_effects(img: Image.Image, seed: int = 42) -> Image.Image:
    """Apply realistic scan degradation: micro-blur, contrast, subtle noise."""
    np.random.seed(seed)
    # Subtle blur to simulate optical lens MTF
    img = img.filter(ImageFilter.GaussianBlur(radius=0.4))
    arr = np.array(img, dtype=np.float32)

    # Vignette / slight margin shading
    h, w, _ = arr.shape
    y, x = np.ogrid[:h, :w]
    center_y, center_x = h / 2.0, w / 2.0
    dist = np.sqrt(((x - center_x) / (w / 2.0)) ** 2 + ((y - center_y) / (h / 2.0)) ** 2)
    vignette = 1.0 - 0.03 * np.clip(dist - 0.7, 0, 1)
    arr = arr * vignette[..., np.newaxis]

    # Sensor noise
    noise = np.random.normal(0, 0.8, arr.shape)
    arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


# Document Specifications
DOC_SPECS = [
    # ------------------ HINDI (hi) ------------------
    {
        "doc_id": "hi_01_prescription",
        "lang": "hi",
        "doc_type": "prescription",
        "filename": "hi/hi_01_prescription.png",
        "header_hospital": "अपोलो क्लिनिक एवं अनुसंधान केंद्र",
        "header_sub": "12, एमजी रोड, सिविल लाइंस, नई दिल्ली | दूरभाष: 011-23456789",
        "doctor_name": "डॉ. राजेश कुमार शर्मा",
        "doctor_qual": "एम.डी. (जनरल मेडिसिन), वरिष्ठ चिकित्सक",
        "patient_name": "श्री अमित वर्मा",
        "patient_age": "45 वर्ष",
        "patient_gender": "पुरुष",
        "date": "12/03/2026",
        "diagnosis": "प्राथमिक उच्च रक्तचाप एवं टाइप २ मधुमेह (Hypertension & Type 2 Diabetes)",
        "items": [
            ("1. Tab. Metformin (मेटफॉर्मिन) 500 mg", "1 गोली दिन में दो बार भोजन के बाद (1-0-1)", "30 दिन"),
            ("2. Tab. Telmisartan (टेल्मिसार्टन) 40 mg", "1 गोली सुबह नाश्ते के बाद (1-0-0)", "30 दिन"),
            ("3. Tab. Pan 40 (पैंटोप्राजोल) 40 mg", "1 गोली खाली पेट सुबह (1-0-0)", "15 दिन"),
            ("4. Tab. Neurobion Forte", "1 गोली रात को भोजन के बाद (0-0-1)", "30 दिन"),
        ],
        "instructions": "मीठा, तला हुआ और अत्यधिक नमक युक्त भोजन न करें। प्रतिदिन ३० मिनट टहलें।\nरक्त शर्करा स्तर की नियमित निगरानी करें। पुनः परामर्श: २ सप्ताह बाद।",
        "patient_info": {"name": "श्री अमित वर्मा", "age": 45, "gender": "M", "doctorName": "डॉ. राजेश कुमार शर्मा", "date": "2026-03-12"},
        "medications": [
            {"name": "Metformin", "dosage": "500 mg", "frequency": "1-0-1", "duration": "30 days"},
            {"name": "Telmisartan", "dosage": "40 mg", "frequency": "1-0-0", "duration": "30 days"},
            {"name": "Pan 40", "dosage": "40 mg", "frequency": "1-0-0", "duration": "15 days"},
            {"name": "Neurobion Forte", "dosage": "1 tab", "frequency": "0-0-1", "duration": "30 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "hi_02_prescription",
        "lang": "hi",
        "doc_type": "prescription",
        "filename": "hi/hi_02_prescription.png",
        "header_hospital": "संजीवनी मल्टीस्पेशलिटी अस्पताल",
        "header_sub": "स्टेशन रोड, लखनऊ | आपातकालीन सेवा २४ घंटे उपलब्ध",
        "doctor_name": "डॉ. सुनीता गुप्ता",
        "doctor_qual": "एम.एस. (ई.एन.टी.), कान, नाक एवं गला विशेषज्ञ",
        "patient_name": "श्रीमती रेखा देवी",
        "patient_age": "38 वर्ष",
        "patient_gender": "महिला",
        "date": "15/03/2026",
        "diagnosis": "तीव्र ग्रसनीशोथ एवं एलर्जिक राइनाइटिस (Acute Pharyngitis)",
        "items": [
            ("1. Cap. Amoxicillin (एमोक्सिसिलिन) 500 mg", "1 कैप्सूल दिन में तीन बार खाने के बाद", "5 दिन"),
            ("2. Tab. Dolo (पैरासिटामोल) 650 mg", "1 गोली आवश्यकतानुसार दर्द व बुखार होने पर", "3 दिन"),
            ("3. Tab. Cetirizine (सेटिरिज़िन) 10 mg", "1 गोली रात को सोते समय", "7 दिन"),
            ("4. Betadine Gargle (गर्गल लिक्विड)", "गुनगुने पानी में डालकर दिन में ३ बार गरारे करें", "5 दिन"),
        ],
        "instructions": "ठंडा पानी व तैलीय खाद्य पदार्थों से बचें। भाप लें और पर्याप्त आराम करें।\nलक्षण बने रहने पर तुरंत संपर्क करें।",
        "patient_info": {"name": "श्रीमती रेखा देवी", "age": 38, "gender": "F", "doctorName": "डॉ. सुनीता गुप्ता", "date": "2026-03-15"},
        "medications": [
            {"name": "Amoxicillin", "dosage": "500 mg", "frequency": "TID", "duration": "5 days"},
            {"name": "Dolo", "dosage": "650 mg", "frequency": "SOS", "duration": "3 days"},
            {"name": "Cetirizine", "dosage": "10 mg", "frequency": "HS", "duration": "7 days"},
            {"name": "Betadine Gargle", "dosage": "liquid", "frequency": "TID", "duration": "5 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "hi_03_lab_report",
        "lang": "hi",
        "doc_type": "lab_report",
        "filename": "hi/hi_03_lab_report.png",
        "header_hospital": "मेट्रो डायग्नोस्टिक्स एवं पैथोलॉजी लैब",
        "header_sub": "सत्यापित एनएबीएल मान्यता प्राप्त प्रयोगशाला | रिंग रोड, कानपुर",
        "doctor_name": "डॉ. अरुण मेहरोत्रा",
        "doctor_qual": "एम.डी. (पैथोलॉजी), मुख्य पैथोलॉजिस्ट",
        "patient_name": "श्री विजय प्रताप सिंह",
        "patient_age": "50 वर्ष",
        "patient_gender": "पुरुष",
        "date": "16/03/2026",
        "diagnosis": "रक्त परीक्षण रिपोर्ट - सीबीसी (Complete Blood Count)",
        "table_headers": ["परीक्षण का नाम (Test)", "परिणाम (Result)", "इकाई (Unit)", "संदर्भ सीमा (Reference)"],
        "table_rows": [
            ["हीमोग्लोबिन (Hemoglobin)", "13.8", "g/dL", "13.0 - 17.0"],
            ["कुल ल्यूकोसाइट गणना (TLC)", "7,400", "/cu.mm", "4,000 - 11,000"],
            ["प्लेटलेट्स गणना (Platelets)", "2,45,000", "/cu.mm", "1,50,000 - 4,50,000"],
            ["आरबीसी गणना (RBC Count)", "4.8", "mil/cu.mm", "4.5 - 5.5"],
            ["पैक्ड सेल वॉल्यूम (PCV)", "42.0", "%", "40.0 - 50.0"],
            ["ई.एस.आर. (ESR)", "12", "mm/hr", "0 - 15"],
        ],
        "patient_info": {"name": "श्री विजय प्रताप सिंह", "age": 50, "gender": "M", "doctorName": "डॉ. अरुण मेहरोत्रा", "date": "2026-03-16"},
        "medications": [],
        "lab_results": [
            {"testName": "Hemoglobin", "value": 13.8, "unit": "g/dL", "referenceRange": "13.0 - 17.0"},
            {"testName": "TLC", "value": 7400, "unit": "/cu.mm", "referenceRange": "4000 - 11000"},
            {"testName": "Platelets", "value": 245000, "unit": "/cu.mm", "referenceRange": "150000 - 450000"},
            {"testName": "ESR", "value": 12, "unit": "mm/hr", "referenceRange": "0 - 15"},
        ],
    },
    {
        "doc_id": "hi_04_lab_table",
        "lang": "hi",
        "doc_type": "lab_report",
        "filename": "hi/hi_04_lab_table.png",
        "header_hospital": "मेट्रो डायग्नोस्टिक्स एवं पैथोलॉजी लैब",
        "header_sub": "लिपिड प्रोफाइल परीक्षण रिपोर्ट | जांच संदर्भ: LP-90214",
        "doctor_name": "डॉ. अरुण मेहरोत्रा",
        "doctor_qual": "एम.डी. (पैथोलॉजी)",
        "patient_name": "श्री मोहन लाल शर्मा",
        "patient_age": "58 वर्ष",
        "patient_gender": "पुरुष",
        "date": "17/03/2026",
        "diagnosis": "लिपिड प्रोफाइल परीक्षण (Lipid Profile Panel)",
        "table_headers": ["जांच विवरण (Test Name)", "प्राप्त मान (Result)", "इकाई (Unit)", "सामान्य सीमा (Ref Range)"],
        "table_rows": [
            ["कुल कोलेस्ट्रॉल (Total Cholesterol)", "188", "mg/dL", "< 200"],
            ["ट्राइग्लिसराइड्स (Triglycerides)", "142", "mg/dL", "< 150"],
            ["एचडीएल कोलेस्ट्रॉल (HDL Good)", "46", "mg/dL", "> 40"],
            ["एलडीएल कोलेस्ट्रॉल (LDL Bad)", "114", "mg/dL", "< 100"],
            ["वीएलडीएल कोलेस्ट्रॉल (VLDL)", "28", "mg/dL", "< 30"],
        ],
        "patient_info": {"name": "श्री मोहन लाल शर्मा", "age": 58, "gender": "M", "doctorName": "डॉ. अरुण मेहरोत्रा", "date": "2026-03-17"},
        "medications": [],
        "lab_results": [
            {"testName": "Total Cholesterol", "value": 188, "unit": "mg/dL", "referenceRange": "< 200"},
            {"testName": "Triglycerides", "value": 142, "unit": "mg/dL", "referenceRange": "< 150"},
            {"testName": "HDL", "value": 46, "unit": "mg/dL", "referenceRange": "> 40"},
            {"testName": "LDL", "value": 114, "unit": "mg/dL", "referenceRange": "< 100"},
        ],
    },
    {
        "doc_id": "hi_05_discharge",
        "lang": "hi",
        "doc_type": "discharge",
        "filename": "hi/hi_05_discharge.png",
        "header_hospital": "अखिल भारतीय आयुर्विज्ञान संस्थान (एम्स) सहयोगी केंद्र",
        "header_sub": "रोगी डिस्चार्ज सारांश पत्रक | पंजीकरण संख्या: AI-2026-8812",
        "doctor_name": "डॉ. विवेक आनंद",
        "doctor_qual": "विभागाध्यक्ष, इंटरनल मेडिसिन",
        "patient_name": "श्री रमेश चंद्र",
        "patient_age": "62 वर्ष",
        "patient_gender": "पुरुष",
        "date": "18/03/2026",
        "diagnosis": "तीव्र गैस्ट्रोएंटेराइटिस एवं निर्जलीकरण (Acute Gastroenteritis with Dehydration)",
        "discharge_text": (
            "भर्ती तिथि: १२/०३/२०२६ | डिस्चार्ज तिथि: १८/०३/२०२६\n\n"
            "रोग इतिहास एवं परीक्षण:\n"
            "मरीज को उल्टी, दस्त और अत्यधिक कमजोरी की शिकायत के साथ आपातकालीन कक्ष में लाया गया था।\n"
            "प्रारंभिक रक्तचाप: ९०/६० mmHg, नाड़ी दर: ९८/मिनट। सीबीसी व सीरम इलेक्ट्रोलाइट्स की जांच की गई।\n\n"
            "उपचार विवरण:\n"
            "मरीज को अंतःशिरा (IV) फ्लुइड्स, ओन्डैनसेट्रॉन और सिप्रोफ्लोक्सासिन दिया गया।\n"
            "चार दिनों के सघन उपचार के पश्चात रोगी की स्थिति पूर्णतः स्थिर है और वह सामान्य आहार ले रहे हैं।\n\n"
            "डिस्चार्ज पश्चात परामर्श एवं दवाइयां:\n"
            "१. ओआरएस (ORS) घोल पर्याप्त मात्रा में पिएं।\n"
            "२. Tab. Ciprofloxacin 500 mg - दिन में दो बार (१-०-१) ३ दिन तक।\n"
            "३. Tab. Pantoprazole 40 mg - सुबह खाली पेट ५ दिन तक।"
        ),
        "patient_info": {"name": "श्री रमेश चंद्र", "age": 62, "gender": "M", "doctorName": "डॉ. विवेक आनंद", "date": "2026-03-18"},
        "medications": [
            {"name": "Ciprofloxacin", "dosage": "500 mg", "frequency": "1-0-1", "duration": "3 days"},
            {"name": "Pantoprazole", "dosage": "40 mg", "frequency": "1-0-0", "duration": "5 days"},
        ],
        "lab_results": [],
    },

    # ------------------ MARATHI (mr) ------------------
    {
        "doc_id": "mr_01_prescription",
        "lang": "mr",
        "doc_type": "prescription",
        "filename": "mr/mr_01_prescription.png",
        "header_hospital": "सह्याद्री सुपर स्पेशालिटी रुग्णालय",
        "header_sub": "कर्वे रोड, डेक्कन जिमखाना, पुणे | फोन: ०२०-६७२१५०००",
        "doctor_name": "डॉ. प्रकाश जोशी",
        "doctor_qual": "एम.डी. (हृदयरोगतज्ज्ञ), फेलो अमेरिकन कॉलेज",
        "patient_name": "श्री. सुरेश कुलकर्णी",
        "patient_age": "५२ वर्षे",
        "patient_gender": "पुरुष",
        "date": "१८/०३/२०२६",
        "diagnosis": "उच्च रक्तदाब आणि इसिमिक हृदयविकार (Hypertension & IHD)",
        "items": [
            ("१. Tab. Amlodipine (अम्लोडिपाइन) 5 mg", "दररोज सकाळी १ गोळी नाश्त्यानंतर (१-०-०)", "३० दिवस"),
            ("२. Tab. Atorvastatin (अ‍ॅटोर्वास्टॅटिन) 10 mg", "रात्री झोपताना १ गोळी (०-०-१)", "३० दिवस"),
            ("३. Tab. Ecosprin (इकोस्प्रिन) 75 mg", "दुपारी जेवणानंतर १ गोळी (०-१-०)", "३० दिवस"),
            ("४. Tab. Metoprolol XL 25 mg", "सकाळी १ गोळी नाश्त्यानंतर (१-०-०)", "३० दिवस"),
        ],
        "instructions": "आहारात मिठाचे प्रमाण कमी ठेवा. तेलकट व तिखट पदार्थ टाळा. दररोज सकाळी ३० मिनिटे चाला.\nछातीत दुखणे किंवा श्वास घेण्यास त्रास झाल्यास तात्काळ संपर्क साधा. पुढील तपासणी: १ महिन्याने.",
        "patient_info": {"name": "श्री. सुरेश कुलकर्णी", "age": 52, "gender": "M", "doctorName": "डॉ. प्रकाश जोशी", "date": "2026-03-18"},
        "medications": [
            {"name": "Amlodipine", "dosage": "5 mg", "frequency": "1-0-0", "duration": "30 days"},
            {"name": "Atorvastatin", "dosage": "10 mg", "frequency": "0-0-1", "duration": "30 days"},
            {"name": "Ecosprin", "dosage": "75 mg", "frequency": "0-1-0", "duration": "30 days"},
            {"name": "Metoprolol XL", "dosage": "25 mg", "frequency": "1-0-0", "duration": "30 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "mr_02_prescription",
        "lang": "mr",
        "doc_type": "prescription",
        "filename": "mr/mr_02_prescription.png",
        "header_hospital": "धन्वंतरी क्लिनिक व आरोग्य केंद्र",
        "header_sub": "टिळक पथ, नाशिक | रुग्णसेवा हीच ईश्वरसेवा",
        "doctor_name": "डॉ. अनिता देशमुख",
        "doctor_qual": "एम.बी.बी.एस., डी.जी.ओ., स्त्रीरोग व प्रसूती तज्ज्ञ",
        "patient_name": "सौ. स्वाती पाटील",
        "patient_age": "३४ वर्षे",
        "patient_gender": "स्त्री",
        "date": "२०/०३/२०२६",
        "diagnosis": "तीव्र श्वसननलिका दाह आणि खोकला (Acute Bronchitis)",
        "items": [
            ("१. Tab. Cefixime (सेफिक्सिम) 200 mg", "सकाळी व संध्याकाळी जेवणानंतर १ गोळी (१-०-१)", "५ दिवस"),
            ("२. Tab. Dolo (डोलो) 650 mg", "ताप किंवा अंगदुखी असल्यास १ गोळी", "३ दिवस"),
            ("३. Tab. Montair-LC (माँटेअर एलसी)", "रात्री जेवणानंतर १ गोळी (०-०-१)", "१० दिवस"),
            ("४. Cough Syrup Ascoril-LS", "२ चमचे दिवसातून तीन वेळा कोमट पाण्यासोबत", "५ दिवस"),
        ],
        "instructions": "कोमट पाण्याचे सेवन करा. थंड पाणी व शीतपेये टाळा. पुरेशी विश्रांती घ्या.",
        "patient_info": {"name": "सौ. स्वाती पाटील", "age": 34, "gender": "F", "doctorName": "डॉ. अनिता देशमुख", "date": "2026-03-20"},
        "medications": [
            {"name": "Cefixime", "dosage": "200 mg", "frequency": "1-0-1", "duration": "5 days"},
            {"name": "Dolo", "dosage": "650 mg", "frequency": "SOS", "duration": "3 days"},
            {"name": "Montair-LC", "dosage": "1 tab", "frequency": "0-0-1", "duration": "10 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "mr_03_lab_report",
        "lang": "mr",
        "doc_type": "lab_report",
        "filename": "mr/mr_03_lab_report.png",
        "header_hospital": "पुणे पॅथॉलॉजी व मायक्रोबायोलॉजी लॅब",
        "header_sub": "प्रमाणित पॅथॉलॉजी तपासणी अहवाल | एफसी रोड, पुणे",
        "doctor_name": "डॉ. सुहास चितळे",
        "doctor_qual": "एम.डी. (पॅथॉलॉजी)",
        "patient_name": "श्री. विलास बापट",
        "patient_age": "४६ वर्षे",
        "patient_gender": "पुरुष",
        "date": "२१/०३/२०२६",
        "diagnosis": "संपूर्ण रक्त तपासणी अहवाल (Complete Blood Count)",
        "table_headers": ["तपासणी घटक (Test)", "आढळलेले मूल्य (Result)", "एकक (Unit)", "सामान्य श्रेणी (Reference)"],
        "table_rows": [
            ["हिमोग्लोबिन (Hemoglobin)", "13.2", "gm%", "13.0 - 17.0"],
            ["पांढऱ्या पेशींची संख्या (WBC Count)", "6,800", "/cumm", "4,000 - 10,000"],
            ["तांबड्या पेशींची संख्या (RBC)", "4.6", "million/cumm", "4.5 - 5.5"],
            ["प्लेटलेट पेशी (Platelet Count)", "2,20,000", "/cumm", "1,50,000 - 4,50,000"],
            ["न्यूट्रोफिल्स (Neutrophils)", "62", "%", "40 - 75"],
            ["लिम्फोसाइट्स (Lymphocytes)", "30", "%", "20 - 45"],
        ],
        "patient_info": {"name": "श्री. विलास बापट", "age": 46, "gender": "M", "doctorName": "डॉ. सुहास चितळे", "date": "2026-03-21"},
        "medications": [],
        "lab_results": [
            {"testName": "Hemoglobin", "value": 13.2, "unit": "gm%", "referenceRange": "13.0 - 17.0"},
            {"testName": "WBC Count", "value": 6800, "unit": "/cumm", "referenceRange": "4000 - 10000"},
            {"testName": "Platelets", "value": 220000, "unit": "/cumm", "referenceRange": "150000 - 450000"},
        ],
    },
    {
        "doc_id": "mr_04_lab_table",
        "lang": "mr",
        "doc_type": "lab_report",
        "filename": "mr/mr_04_lab_table.png",
        "header_hospital": "पुणे पॅथॉलॉजी व मायक्रोबायोलॉजी लॅब",
        "header_sub": "यकृत कार्य चाचणी अहवाल (Liver Function Test)",
        "doctor_name": "डॉ. सुहास चितळे",
        "doctor_qual": "एम.डी. (पॅथॉलॉजी)",
        "patient_name": "श्रीमती मीनाक्षी जोशी",
        "patient_age": "५० वर्षे",
        "patient_gender": "स्त्री",
        "date": "२२/०३/२०२६",
        "diagnosis": "यकृत कार्य चाचणी (LFT Panel)",
        "table_headers": ["चाचणी तपशील (Test)", "चाचणी निकाल (Result)", "एकक (Unit)", "प्रमाणित मर्यादा (Range)"],
        "table_rows": [
            ["एकूण बिलीरुबिन (Total Bilirubin)", "0.85", "mg/dL", "0.2 - 1.2"],
            ["थेट बिलीरुबिन (Direct Bilirubin)", "0.22", "mg/dL", "0.0 - 0.3"],
            ["एस.जी.ओ.टी. (SGOT / AST)", "29", "U/L", "5 - 40"],
            ["एस.जी.पी.टी. (SGPT / ALT)", "34", "U/L", "5 - 45"],
            ["अल्कधर्मी फॉस्फेटस (ALP)", "88", "U/L", "30 - 120"],
            ["एकूण प्रथिने (Total Protein)", "7.2", "g/dL", "6.0 - 8.3"],
        ],
        "patient_info": {"name": "श्रीमती मीनाक्षी जोशी", "age": 50, "gender": "F", "doctorName": "डॉ. सुहास चितळे", "date": "2026-03-22"},
        "medications": [],
        "lab_results": [
            {"testName": "Total Bilirubin", "value": 0.85, "unit": "mg/dL", "referenceRange": "0.2 - 1.2"},
            {"testName": "SGOT", "value": 29, "unit": "U/L", "referenceRange": "5 - 40"},
            {"testName": "SGPT", "value": 34, "unit": "U/L", "referenceRange": "5 - 45"},
            {"testName": "Alkaline Phosphatase", "value": 88, "unit": "U/L", "referenceRange": "30 - 120"},
        ],
    },
    {
        "doc_id": "mr_05_consultation",
        "lang": "mr",
        "doc_type": "consultation",
        "filename": "mr/mr_05_consultation.png",
        "header_hospital": "संजीवन ऑर्थोपेडिक व सांधेबदल केंद्र",
        "header_sub": "तपासणी व सल्लागार नोंदणी पत्रक | बाणेर, पुणे",
        "doctor_name": "डॉ. रवींद्र घाणेकर",
        "doctor_qual": "एम.एस. (ऑर्थो), अस्थिरोग व सांधेतज्ज्ञ",
        "patient_name": "श्री. आनंदराव जाधव",
        "patient_age": "५९ वर्षे",
        "patient_gender": "पुरुष",
        "date": "२३/०३/२०२६",
        "diagnosis": "दोन्ही गुडघ्यांचा ऑस्टिओआर्थराइटिस (Bilateral Knee OA)",
        "discharge_text": (
            "तक्रारी व पूर्व इतिहास:\n"
            "गेल्या ६ महिन्यांपासून दोन्ही गुडघ्यांत तीव्र वेदना, विशेषतः जिने चढताना व चालताना त्रास होतो.\n"
            "सकाळी उठल्यावर सांधे ताठरणे व सूज येणे.\n\n"
            "वैद्यकीय तपासणी निष्कर्ष:\n"
            "गुडघ्यावर सूज, हालचालींवर मर्यादा व क्रॅपिटस (Crepitus) उपस्थित.\n"
            "रक्तदाब: १३२/८४ mmHg, नाडी: ७८/मिनिट. वजन: ७४ किग्रॅ.\n"
            "एक्स-रे निष्कर्ष: जॉइंट स्पेस कमी झालेली दिसून येते (Grade 2 OA).\n\n"
            "उपचार व फिजिओथेरपी सल्ला:\n"
            "१. Tab. Paracetamol 650 mg - वेदना तीव्र असल्यास १ गोळी जेवणानंतर.\n"
            "२. Tab. Calcium + Vitamin D3 - दररोज दुपारच्या जेवणानंतर १ गोळी ३ महिने.\n"
            "३. क्वाड्रिसेप्स स्नायू बळकटीचे व्यायाम नियमित करावेत.\n"
            "४. खाली मांडी घालून बसणे आणि जिने चढ-उतार करणे टाळावे."
        ),
        "patient_info": {"name": "श्री. आनंदराव जाधव", "age": 59, "gender": "M", "doctorName": "डॉ. रवींद्र घाणेकर", "date": "2026-03-23"},
        "medications": [
            {"name": "Paracetamol", "dosage": "650 mg", "frequency": "SOS", "duration": "as needed"},
            {"name": "Calcium + Vitamin D3", "dosage": "1 tab", "frequency": "0-1-0", "duration": "90 days"},
        ],
        "lab_results": [],
    },

    # ------------------ TAMIL (ta) ------------------
    {
        "doc_id": "ta_01_prescription",
        "lang": "ta",
        "doc_type": "prescription",
        "filename": "ta/ta_01_prescription.png",
        "header_hospital": "காவேரி மருத்துவமனை மற்றும் ஆராய்ச்சி மையம்",
        "header_sub": "15, அண்ணா சாலை, சென்னை | தொலைபேசி: 044-24567890",
        "doctor_name": "டாக்டர் எஸ். சுப்பிரமணியன்",
        "doctor_qual": "M.D. (பொது மருத்துவம்), தலைமை மருத்துவர்",
        "patient_name": "திரு. கே. ரங்கநாதன்",
        "patient_age": "48 வயது",
        "patient_gender": "ஆண்",
        "date": "22/03/2026",
        "diagnosis": "டைப் 2 நீரிழிவு நோய் மற்றும் ரத்தக் கொதிப்பு (Diabetes & Hypertension)",
        "items": [
            ("1. Tab. Glycomet (மெட்பார்மின்) 500 mg", "காலை, இரவு உணவுக்கு பின் 1 மாத்திரை (1-0-1)", "30 நாட்கள்"),
            ("2. Tab. Cilacar (சிலாகார்) 10 mg", "காலை உணவுக்கு பின் 1 மாத்திரை (1-0-0)", "30 நாட்கள்"),
            ("3. Tab. Pan 40 (பான் 40)", "காலை வெறும் வயிற்றில் 1 மாத்திரை (1-0-0)", "15 நாட்கள்"),
            ("4. Tab. Neurobion Forte", "இரவு உணவுக்கு பின் 1 மாத்திரை (0-0-1)", "30 நாட்கள்"),
        ],
        "instructions": "உணவில் உப்பு மற்றும் இனிப்பை முழுமையாக குறைக்கவும். தினமும் 30 நிமிடம் நடைப்பயிற்சி செய்யவும்.\nரத்த சர்க்கரை அளவை தவறாமல் பரிசோதிக்கவும். அடுத்த மருத்துவ ஆலோசனை: 1 மாதம் கழித்து.",
        "patient_info": {"name": "திரு. கே. ரங்கநாதன்", "age": 48, "gender": "M", "doctorName": "டாக்டர் எஸ். சுப்பிரமணியன்", "date": "2026-03-22"},
        "medications": [
            {"name": "Glycomet", "dosage": "500 mg", "frequency": "1-0-1", "duration": "30 days"},
            {"name": "Cilacar", "dosage": "10 mg", "frequency": "1-0-0", "duration": "30 days"},
            {"name": "Pan 40", "dosage": "40 mg", "frequency": "1-0-0", "duration": "15 days"},
            {"name": "Neurobion Forte", "dosage": "1 tab", "frequency": "0-0-1", "duration": "30 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "ta_02_prescription",
        "lang": "ta",
        "doc_type": "prescription",
        "filename": "ta/ta_02_prescription.png",
        "header_hospital": "மீனாட்சி மெடிக்கல் சென்டர்",
        "header_sub": "மேலூர் சாலை, மதுரை | 24 மணி நேர அவசர சிகிச்சை பிரிவு",
        "doctor_name": "டாக்டர் கே. லட்சுமி",
        "doctor_qual": "M.B.B.S., D.C.H., குழந்தைகள் நல சிறப்பு மருத்துவர்",
        "patient_name": "செல்வன் பிரவீன்",
        "patient_age": "12 வயது",
        "patient_gender": "ஆண்",
        "date": "24/03/2026",
        "diagnosis": "கடுமையான தொண்டை வலி மற்றும் சளி காய்ச்சல் (Acute Tonsillitis)",
        "items": [
            ("1. Tab. Azithromycin (அசித்ரோமைசின்) 250 mg", "மதிய உணவுக்கு பின் 1 மாத்திரை (0-1-0)", "3 நாட்கள்"),
            ("2. Tab. Paracetamol (பாராசிட்டமால்) 500 mg", "காய்ச்சல் இருந்தால் மட்டும் 1 மாத்திரை", "3 நாட்கள்"),
            ("3. Syrup Levocetirizine 5 ml", "இரவு படுக்கைக்கு முன் 1 முறை", "5 நாட்கள்"),
        ],
        "instructions": "வெதுவெதுப்பான உப்பு நீரில் தொண்டையை கொப்பளிக்கவும். குளிர்ந்த உணவுகளை தவிர்க்கவும்.",
        "patient_info": {"name": "செல்வன் பிரவீன்", "age": 12, "gender": "M", "doctorName": "டாக்டர் கே. லட்சுமி", "date": "2026-03-24"},
        "medications": [
            {"name": "Azithromycin", "dosage": "250 mg", "frequency": "0-1-0", "duration": "3 days"},
            {"name": "Paracetamol", "dosage": "500 mg", "frequency": "SOS", "duration": "3 days"},
            {"name": "Levocetirizine", "dosage": "5 ml", "frequency": "HS", "duration": "5 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "ta_03_lab_report",
        "lang": "ta",
        "doc_type": "lab_report",
        "filename": "ta/ta_03_lab_report.png",
        "header_hospital": "அப்பல்லோ டயக்னாஸ்டிக்ஸ் மையம்",
        "header_sub": "அங்கீகரிக்கப்பட்ட ரத்த பரிசோதனை கூடம் | தியாகராய நகர், சென்னை",
        "doctor_name": "டாக்டர் எம். நடராஜன்",
        "doctor_qual": "M.D. (பத்தாலஜி), ஆய்வக இயக்குனர்",
        "patient_name": "திருமதி வனிதா மோகன்",
        "patient_age": "41 வயது",
        "patient_gender": "பெண்",
        "date": "25/03/2026",
        "diagnosis": "ரத்த பரிசோதனை அறிக்கை (Blood Sugar & CBC Panel)",
        "table_headers": ["பரிசோதனை பெயர் (Test)", "கண்டறியப்பட்ட அளவு (Result)", "அலகு (Unit)", "சாதாரண வரம்பு (Ref Range)"],
        "table_rows": [
            ["ஹீமோகுளோபின் (Hemoglobin)", "12.6", "g/dL", "12.0 - 15.0"],
            ["வெள்ளை அணுக்கள் (WBC Count)", "7,100", "cells/cu.mm", "4,000 - 11,000"],
            ["வெறும் வயிற்று சர்க்கரை (FBS)", "116", "mg/dL", "70 - 100"],
            ["உணவுக்குப் பின் சர்க்கரை (PPBS)", "162", "mg/dL", "< 140"],
            ["கிளைகேட்டட் ஹீமோகுளோபின் (HbA1c)", "6.8", "%", "< 5.7"],
            ["ரத்த தட்டணுக்கள் (Platelets)", "2,50,000", "/cu.mm", "1,50,000 - 4,50,000"],
        ],
        "patient_info": {"name": "திருமதி வனிதா மோகன்", "age": 41, "gender": "F", "doctorName": "டாக்டர் எம். நடராஜன்", "date": "2026-03-25"},
        "medications": [],
        "lab_results": [
            {"testName": "Hemoglobin", "value": 12.6, "unit": "g/dL", "referenceRange": "12.0 - 15.0"},
            {"testName": "Fasting Blood Sugar", "value": 116, "unit": "mg/dL", "referenceRange": "70 - 100"},
            {"testName": "Post Prandial Sugar", "value": 162, "unit": "mg/dL", "referenceRange": "< 140"},
            {"testName": "HbA1c", "value": 6.8, "unit": "%", "referenceRange": "< 5.7"},
        ],
    },
    {
        "doc_id": "ta_04_lab_table",
        "lang": "ta",
        "doc_type": "lab_report",
        "filename": "ta/ta_04_lab_table.png",
        "header_hospital": "அப்பல்லோ டயக்னாஸ்டிக்ஸ் மையம்",
        "header_sub": "சிறுநீரக செயல்பாடு பரிசோதனை அறிக்கை (Renal Function Test)",
        "doctor_name": "டாக்டர் எம். நடராஜன்",
        "doctor_qual": "M.D. (பத்தாலஜி)",
        "patient_name": "திரு. எஸ். தர்மலிங்கம்",
        "patient_age": "55 வயது",
        "patient_gender": "ஆண்",
        "date": "26/03/2026",
        "diagnosis": "சிறுநீரக செயல்பாடு பரிசோதனை (RFT Panel)",
        "table_headers": ["பரிசோதனை விபரம் (Test)", "முடிவு அளவு (Result)", "அலகு (Unit)", "இயல்பு எல்லை (Normal)"],
        "table_rows": [
            ["ரத்த யூரியா (Blood Urea)", "26", "mg/dL", "15 - 40"],
            ["சீரம் கிரியேட்டினின் (Creatinine)", "0.95", "mg/dL", "0.6 - 1.2"],
            ["யூரிக் அமிலம் (Serum Uric Acid)", "5.4", "mg/dL", "3.5 - 7.2"],
            ["சீரம் சோடியம் (Serum Sodium)", "139", "mEq/L", "136 - 145"],
            ["சீரம் பொட்டாசியம் (Potassium)", "4.3", "mEq/L", "3.5 - 5.1"],
        ],
        "patient_info": {"name": "திரு. எஸ். தர்மலிங்கம்", "age": 55, "gender": "M", "doctorName": "டாக்டர் எம். நடராஜன்", "date": "2026-03-26"},
        "medications": [],
        "lab_results": [
            {"testName": "Blood Urea", "value": 26, "unit": "mg/dL", "referenceRange": "15 - 40"},
            {"testName": "Serum Creatinine", "value": 0.95, "unit": "mg/dL", "referenceRange": "0.6 - 1.2"},
            {"testName": "Serum Uric Acid", "value": 5.4, "unit": "mg/dL", "referenceRange": "3.5 - 7.2"},
            {"testName": "Sodium", "value": 139, "unit": "mEq/L", "referenceRange": "136 - 145"},
            {"testName": "Potassium", "value": 4.3, "unit": "mEq/L", "referenceRange": "3.5 - 5.1"},
        ],
    },
    {
        "doc_id": "ta_05_lab_report",
        "lang": "ta",
        "doc_type": "discharge",
        "filename": "ta/ta_05_lab_report.png",
        "header_hospital": "சென்னை அரசு பொது மருத்துவமனை",
        "header_sub": "வெளியேற்ற சுருக்க அறிக்கை (Discharge Summary Sheet)",
        "doctor_name": "டாக்டர் ஆர். பாலசந்தர்",
        "doctor_qual": "M.D., பொது மருத்துவ பேராசிரியர்",
        "patient_name": "திரு. ஆறுமுகம்",
        "patient_age": "53 வயது",
        "patient_gender": "ஆண்",
        "date": "27/03/2026",
        "diagnosis": "கடுமையான இரைப்பை குடல் அழற்சி (Acute Gastroenteritis)",
        "discharge_text": (
            "சேர்க்கை தேதி: 20/03/2026 | வெளியேற்ற தேதி: 27/03/2026\n\n"
            "நோயாளியின் நிலையும் மருத்துவ பரிசோதனையும்:\n"
            "நோயாளி கடுமையான வாந்தி, வயிற்றுப்போக்கு மற்றும் உடல் வறட்சியுடன் அவசர பிரிவில் அனுமதிக்கப்பட்டார்.\n"
            "ரத்த அழுத்தம்: 95/65 mmHg, நாடித் துடிப்பு: 92/நிமிடம்.\n\n"
            "வழங்கப்பட்ட சிகிச்சை விவரங்கள்:\n"
            "உடனடி நரம்பு வழி திரவம் (IV Normal Saline, Ringer Lactate) மற்றும் ஆன்டிபயாடிக் சிகிச்சை வழங்கப்பட்டது.\n"
            "சிகிச்சைக்குப் பின் நோயாளியின் உடல்நிலை நல்ல முன்னேற்றம் அடைந்து சீராக உள்ளது.\n\n"
            "வீட்டிற்கு செல்லும் போது பின்பற்ற வேண்டிய அறிவுரைகள்:\n"
            "1. நன்கு காய்ச்சிய ஆறிய குடிநீரை மட்டும் பருகவும்.\n"
            "2. Tab. Ofloxacin 200 mg - காலை, இரவு உணவுக்கு பின் 5 நாட்கள்.\n"
            "3. Tab. Pantoprazole 40 mg - காலை வெறும் வயிற்றில் 7 நாட்கள்."
        ),
        "patient_info": {"name": "திரு. ஆறுமுகம்", "age": 53, "gender": "M", "doctorName": "டாக்டர் ஆர். பாலசந்தர்", "date": "2026-03-27"},
        "medications": [
            {"name": "Ofloxacin", "dosage": "200 mg", "frequency": "1-0-1", "duration": "5 days"},
            {"name": "Pantoprazole", "dosage": "40 mg", "frequency": "1-0-0", "duration": "7 days"},
        ],
        "lab_results": [],
    },

    # ------------------ GUJARATI (gu) ------------------
    {
        "doc_id": "gu_02_prescription",
        "lang": "gu",
        "doc_type": "prescription",
        "filename": "gu/gu_02_prescription.png",
        "header_hospital": "સ્ટર્લિંગ મલ્ટીસ્પેશિયાલિટી હોસ્પિટલ",
        "header_sub": "મેમનગર, ડ્રાઇવ-ઇન રોડ, અમદાવાદ | ફોન: ૦૭૯-૪૦૦૧૧૧૧",
        "doctor_name": "ડૉ. હર્ષદ મહેતા",
        "doctor_qual": "એમ.ડી. (મેડિસિન), કન્સલ્ટન્ટ ફિઝિશિયન",
        "patient_name": "શ્રી રમણભાઈ પટેલ",
        "patient_age": "૫૬ વર્ષ",
        "patient_gender": "પુરુષ",
        "date": "૨૫/૦૩/૨૦૨૬",
        "diagnosis": "પ્રાથમિક હાઇપરટેન્શન અને ડાયાબિટીસ (Hypertension & Type 2 Diabetes)",
        "items": [
            ("૧. Tab. Glimisave M1 (ગ્લિમીસેવ)", "સવારે ભૂખ્યા પેટે ૧ ગોળી (૧-૦-૦)", "૩૦ દિવસ"),
            ("૨. Tab. Telma 40 (ટેલ્મા ૪૦)", "સવારે નાસ્તા પછી ૧ ગોળી (૧-૦-૦)", "૩૦ દિવસ"),
            ("૩. Tab. Rosuvas 10 (રોસુવાસ ૧૦)", "રાત્રે જમ્યા પછી ૧ ગોળી (૦-૦-૧)", "૩૦ દિવસ"),
            ("૪. Tab. Becosules Z", "બપોરે જમ્યા પછી ૧ કેપ્સ્યુલ (૦-૧-૦)", "૩૦ દિવસ"),
        ],
        "instructions": "મીઠું, ખાંડ અને તેલવાળી વસ્તુઓનો ઉપયોગ ઓછો કરવો. દરરોજ સવારે ૩૦ મિનિટ ઝડપથી ચાલવું.\nબ્લડ પ્રેશર અને સુગરની નિયમિત નોંધ રાખવી. ફરી મુલાકાત: ૧ મહિના પછી.",
        "patient_info": {"name": "શ્રી રમણભાઈ પટેલ", "age": 56, "gender": "M", "doctorName": "ડૉ. હર્ષદ મહેતા", "date": "2026-03-25"},
        "medications": [
            {"name": "Glimisave M1", "dosage": "1 tab", "frequency": "1-0-0", "duration": "30 days"},
            {"name": "Telma 40", "dosage": "40 mg", "frequency": "1-0-0", "duration": "30 days"},
            {"name": "Rosuvas 10", "dosage": "10 mg", "frequency": "0-0-1", "duration": "30 days"},
            {"name": "Becosules Z", "dosage": "1 cap", "frequency": "0-1-0", "duration": "30 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "gu_03_prescription",
        "lang": "gu",
        "doc_type": "prescription",
        "filename": "gu/gu_03_prescription.png",
        "header_hospital": "શિવમ ક્લિનિક અને ડે કેર સેન્ટર",
        "header_sub": "ઘોડદોડ રોડ, સુરત | હેલ્પલાઇન: ૦૨૬૧-૨૭૮૯૧૨૩",
        "doctor_name": "ડૉ. ભાવનાબેન શાહ",
        "doctor_qual": "એમ.બી.બી.એસ., ફેમિલી ફિઝિશિયન",
        "patient_name": "શ્રીમતી જયાબેન સોલંકી",
        "patient_age": "૪૨ વર્ષ",
        "patient_gender": "સ્ત્રી",
        "date": "૨૬/૦૩/૨૦૨૬",
        "diagnosis": "તીવ્ર ગેસ્ટ્રોએન્ટેરાઇટિસ અને પેટનો દુખાવો (Acute Gastroenteritis)",
        "items": [
            ("૧. Tab. Oflox-OZ (ઓફ્લોક્સ ઓઝેડ)", "સવારે અને રાત્રે જમ્યા પછી ૧ ગોળી (૧-૦-૧)", "૫ દિવસ"),
            ("૨. Tab. Dolo 650 (ડોલો ૬૫૦)", "તાવ કે શરીરના દુખાવા માટે જરૂર મુજબ", "૩ દિવસ"),
            ("૩. Tab. Razo 20 (રેબેપ્રાઝોલ ૨૦)", "સવારે ભૂખ્યા પેટે ૧ ગોળી (૧-૦-૦)", "૭ દિવસ"),
            ("૪. Electral Powder (ORS)", "૧ લીટર સ્વચ્છ પાણીમાં ૧ પેકેટ ઓગાળી દિવસ દરમિયાન પીવું", "૩ દિવસ"),
        ],
        "instructions": "હળવો અને બાફેલો ખોરાક લેવો (ખીચડી, છાશ). બહારનો ખોરાક સદંતર બંધ કરવો.",
        "patient_info": {"name": "શ્રીમતી જયાબેન સોલંકી", "age": 42, "gender": "F", "doctorName": "ડૉ. ભાવનાબેન શાહ", "date": "2026-03-26"},
        "medications": [
            {"name": "Oflox-OZ", "dosage": "1 tab", "frequency": "1-0-1", "duration": "5 days"},
            {"name": "Dolo 650", "dosage": "650 mg", "frequency": "SOS", "duration": "3 days"},
            {"name": "Razo 20", "dosage": "20 mg", "frequency": "1-0-0", "duration": "7 days"},
            {"name": "Electral Powder", "dosage": "1 sachet", "frequency": "TID", "duration": "3 days"},
        ],
        "lab_results": [],
    },
    {
        "doc_id": "gu_04_lab_report",
        "lang": "gu",
        "doc_type": "lab_report",
        "filename": "gu/gu_04_lab_report.png",
        "header_hospital": "ગુજરાત પેથોલોજી લેબોરેટરી",
        "header_sub": "એન.એ.બી.એલ. માન્ય ક્લિનિકલ ડાયગ્નોસ્ટિક લેબ | આશ્રમ રોડ, અમદાવાદ",
        "doctor_name": "ડૉ. કિરીટ પરીખ",
        "doctor_qual": "એમ.ડી. (પેથોલોજી), લેબ ડિરેક્ટર",
        "patient_name": "શ્રી વિનોદભાઈ દેસાઈ",
        "patient_age": "૪૭ વર્ષ",
        "patient_gender": "પુરુષ",
        "date": "૨૭/૦૩/૨૦૨૬",
        "diagnosis": "સંપૂર્ણ રક્ત તપાસ અહેવાલ (Complete Blood Count)",
        "table_headers": ["તપાસ વિગત (Investigation)", "પરિણામ (Result)", "એકમ (Unit)", "સામાન્ય મર્યાદા (Reference)"],
        "table_rows": [
            ["હિમોગ્લોબિન (Hemoglobin)", "13.4", "gm%", "13.0 - 17.0"],
            ["કુલ શ્વેતકણ (Total WBC Count)", "7,200", "/cumm", "4,000 - 10,000"],
            ["રક્તકણ (RBC Count)", "4.7", "million/cumm", "4.5 - 5.5"],
            ["પ્લેટલેટ્સ (Platelet Count)", "2,40,000", "/cumm", "1,50,000 - 4,50,000"],
            ["ઇ.એસ.આર. (ESR 1st Hour)", "14", "mm", "0 - 15"],
            ["પી.સી.વી. (PCV)", "41.5", "%", "40.0 - 50.0"],
        ],
        "patient_info": {"name": "શ્રી વિનોદભાઈ દેસાઈ", "age": 47, "gender": "M", "doctorName": "ડૉ. કિરીટ પરીખ", "date": "2026-03-27"},
        "medications": [],
        "lab_results": [
            {"testName": "Hemoglobin", "value": 13.4, "unit": "gm%", "referenceRange": "13.0 - 17.0"},
            {"testName": "Total WBC", "value": 7200, "unit": "/cumm", "referenceRange": "4000 - 10000"},
            {"testName": "Platelets", "value": 240000, "unit": "/cumm", "referenceRange": "150000 - 450000"},
            {"testName": "ESR", "value": 14, "unit": "mm", "referenceRange": "0 - 15"},
        ],
    },
    {
        "doc_id": "gu_05_lab_table",
        "lang": "gu",
        "doc_type": "lab_report",
        "filename": "gu/gu_05_lab_table.png",
        "header_hospital": "ગુજરાત પેથોલોજી લેબોરેટરી",
        "header_sub": "થાઇરોઇડ પ્રોફાઇલ રિપોર્ટ (Thyroid Profile Panel)",
        "doctor_name": "ડૉ. કિરીટ પરીખ",
        "doctor_qual": "એમ.ડી. (પેથોલોજી)",
        "patient_name": "શ્રીમતી મનીષાબેન ત્રિવેદી",
        "patient_age": "૩૯ વર્ષ",
        "patient_gender": "સ્ત્રી",
        "date": "૨૮/૦૩/૨૦૨૬",
        "diagnosis": "થાઇરોઇડ હોર્મોન તપાસ (Thyroid Function Test)",
        "table_headers": ["હોર્મોન તપાસ (Test Name)", "તપાસ મૂલ્ય (Result)", "એકમ (Unit)", "સામાન્ય શ્રેણી (Biological Range)"],
        "table_rows": [
            ["કુલ ટી૩ (Total Triiodothyronine T3)", "1.28", "ng/mL", "0.80 - 2.00"],
            ["કુલ ટી૪ (Total Thyroxine T4)", "8.2", "mcg/dL", "5.1 - 14.1"],
            ["ટી.એસ.એચ. (TSH Ultrasensitive)", "2.65", "uIU/mL", "0.27 - 4.20"],
        ],
        "patient_info": {"name": "શ્રીમતી મનીષાબેન ત્રિવેદી", "age": 39, "gender": "F", "doctorName": "ડૉ. કિરીટ પરીખ", "date": "2026-03-28"},
        "medications": [],
        "lab_results": [
            {"testName": "Total T3", "value": 1.28, "unit": "ng/mL", "referenceRange": "0.80 - 2.00"},
            {"testName": "Total T4", "value": 8.2, "unit": "mcg/dL", "referenceRange": "5.1 - 14.1"},
            {"testName": "TSH", "value": 2.65, "unit": "uIU/mL", "referenceRange": "0.27 - 4.20"},
        ],
    },
]


def render_document(spec: dict, seed: int = 100) -> tuple[Image.Image, str]:
    """Render a clinical document to PIL Image and return (image, verbatim_ground_truth_text)."""
    canvas = create_paper_canvas(width=1600, height=2200, seed=seed)
    draw = ImageDraw.Draw(canvas)

    f_title = get_font(42, bold=True)
    f_sub = get_font(24)
    f_header = get_font(28, bold=True)
    f_body = get_font(25)
    f_bold = get_font(25, bold=True)
    f_table = get_font(23)
    f_table_bold = get_font(23, bold=True)

    text_parts = []

    # 1. Hospital Header
    y = 90
    draw.text((100, y), spec["header_hospital"], font=f_title, fill=(20, 35, 75))
    text_parts.append(spec["header_hospital"])
    y += 58

    draw.text((100, y), spec["header_sub"], font=f_sub, fill=(90, 95, 105))
    text_parts.append(spec["header_sub"])
    y += 42

    # Horizontal double divider line
    draw.line([(90, y), (1510, y)], fill=(40, 60, 110), width=3)
    draw.line([(90, y + 5), (1510, y + 5)], fill=(150, 160, 180), width=1)
    y += 35

    # 2. Doctor Info
    draw.text((100, y), spec["doctor_name"], font=f_header, fill=(25, 30, 40))
    text_parts.append(spec["doctor_name"])
    y += 38
    draw.text((100, y), spec["doctor_qual"], font=f_sub, fill=(80, 85, 95))
    text_parts.append(spec["doctor_qual"])
    y += 45

    # 3. Patient Metadata Box
    box_top = y
    box_bottom = y + 105
    draw.rectangle([(90, box_top), (1510, box_bottom)], fill=(242, 244, 248), outline=(190, 200, 215), width=2)

    pat_line1 = f"દર્દીનું નામ / Patient Name: {spec['patient_name']}    |    ઉંમર / Age: {spec['patient_age']}    |    જાતિ / Gender: {spec['patient_gender']}"
    if spec["lang"] == "hi":
        pat_line1 = f"रोगी का नाम: {spec['patient_name']}    |    आयु: {spec['patient_age']}    |    लिंग: {spec['patient_gender']}"
    elif spec["lang"] == "mr":
        pat_line1 = f"रुग्णाचे नाव: {spec['patient_name']}    |    वय: {spec['patient_age']}    |    लिंग: {spec['patient_gender']}"
    elif spec["lang"] == "ta":
        pat_line1 = f"நோயாளி பெயர்: {spec['patient_name']}    |    வயது: {spec['patient_age']}    |    பாலினம்: {spec['patient_gender']}"

    date_line = f"तारीख / Date: {spec['date']}"
    if spec["lang"] == "ta":
        date_line = f"தேதி / Date: {spec['date']}"
    elif spec["lang"] == "hi":
        date_line = f"दिनांक: {spec['date']}"
    elif spec["lang"] == "mr":
        date_line = f"दिनांक: {spec['date']}"
    elif spec["lang"] == "gu":
        date_line = f"તારીખ: {spec['date']}"

    draw.text((115, box_top + 18), pat_line1, font=f_bold, fill=(30, 35, 45))
    draw.text((115, box_top + 58), date_line, font=f_body, fill=(50, 55, 65))
    text_parts.append(pat_line1)
    text_parts.append(date_line)
    y = box_bottom + 40

    # 4. Diagnosis Header
    draw.text((100, y), f"નિદાન / Diagnosis: {spec['diagnosis']}" if spec["lang"] == "gu" else f"निदान / Diagnosis: {spec['diagnosis']}" if spec["lang"] in ["hi", "mr"] else f"நோய் கண்டறிதல் / Diagnosis: {spec['diagnosis']}", font=f_header, fill=(18, 25, 40))
    text_parts.append(spec["diagnosis"])
    y += 50

    # 5. Document Specific Content
    if spec["doc_type"] == "prescription":
        # Rx symbol
        draw.text((100, y), "℞", font=get_font(44, bold=True), fill=(35, 55, 120))
        y += 55

        for item, dosage, dur in spec["items"]:
            draw.text((120, y), item, font=f_bold, fill=(20, 25, 35))
            y += 34
            draw.text((150, y), f"• {dosage}  ({dur})", font=f_body, fill=(60, 65, 75))
            y += 44
            text_parts.append(f"{item} - {dosage} ({dur})")

        y += 25
        # Instructions Box
        draw.rectangle([(90, y), (1510, y + 150)], outline=(200, 205, 215), width=1)
        draw.text((110, y + 15), "સૂચનાઓ / Instructions:" if spec["lang"] == "gu" else "अति आवश्यक निर्देश:" if spec["lang"] == "hi" else "महत्त्वाच्या सूचना:" if spec["lang"] == "mr" else "முக்கிய அறிவுரைகள்:", font=f_header, fill=(35, 40, 50))
        draw.text((110, y + 55), spec["instructions"], font=f_body, fill=(50, 55, 65))
        text_parts.append(spec["instructions"])

    elif spec["doc_type"] == "lab_report":
        y += 10
        # Table Grid
        headers = spec["table_headers"]
        rows = spec["table_rows"]
        col_x = [90, 680, 1000, 1240, 1510]

        # Header background
        draw.rectangle([(col_x[0], y), (col_x[-1], y + 48)], fill=(232, 238, 248), outline=(180, 195, 215), width=2)
        for i, h_text in enumerate(headers):
            draw.text((col_x[i] + 15, y + 10), h_text, font=f_table_bold, fill=(25, 40, 70))
        text_parts.append(" | ".join(headers))
        y += 48

        for r_idx, row in enumerate(rows):
            bg_col = (255, 255, 255) if r_idx % 2 == 0 else (248, 250, 253)
            draw.rectangle([(col_x[0], y), (col_x[-1], y + 44)], fill=bg_col, outline=(210, 218, 230), width=1)
            # Vertical lines
            for cx in col_x:
                draw.line([(cx, y), (cx, y + 44)], fill=(210, 218, 230), width=1)
            for i, cell_val in enumerate(row):
                draw.text((col_x[i] + 15, y + 9), cell_val, font=f_table, fill=(30, 35, 45))
            text_parts.append(" | ".join(row))
            y += 44

    elif spec["doc_type"] in ["discharge", "consultation"]:
        y += 10
        lines = spec["discharge_text"].split("\n")
        for line in lines:
            if not line.strip():
                y += 18
                continue
            is_bold_title = ":" in line and len(line.split(":")[0]) < 30
            if is_bold_title:
                draw.text((100, y), line, font=f_bold, fill=(20, 25, 40))
                y += 38
            else:
                draw.text((100, y), line, font=f_body, fill=(45, 50, 60))
                y += 34
            text_parts.append(line)

    # Doctor signature / stamp at bottom right
    sig_y = 1940
    draw.line([(1150, sig_y), (1480, sig_y)], fill=(70, 75, 85), width=2)
    draw.text((1180, sig_y + 10), spec["doctor_name"], font=f_bold, fill=(30, 35, 45))
    draw.text((1180, sig_y + 42), "સત્તાવાર સહી અને સિક્કો" if spec["lang"] == "gu" else "अधिकृत हस्ताक्षर एवं मुहर" if spec["lang"] in ["hi", "mr"] else "அங்கீகரிக்கப்பட்ட கையொப்பம்", font=f_sub, fill=(100, 105, 115))

    # Apply realistic scanner physical distortion & noise
    final_img = apply_scanner_effects(canvas, seed=seed)
    verbatim_text = "\n".join(text_parts)
    return final_img, verbatim_text


def generate_rotation_ablation(base_img: Image.Image, out_dir: Path):
    """Generate 0°, 5°, 15°, 45° rotation ablation suite from clean straight base."""
    out_dir.mkdir(parents=True, exist_ok=True)
    angles = [0, 5, 15, 45]

    for angle in angles:
        filename = f"ablation_rot_{angle}deg.png"
        filepath = out_dir / filename
        if angle == 0:
            rotated = base_img.copy()
        else:
            # Pillow rotate with expansion and white background
            # Note: rotate angle counter-clockwise in Pillow, so -angle tilts clockwise
            rotated = base_img.rotate(-angle, expand=True, fillcolor=(250, 249, 246), resample=Image.BICUBIC)

        rotated.save(filepath, "PNG")
        print(f"Saved ablation: {filepath.name} ({rotated.size[0]}x{rotated.size[1]})")


def update_manifest():
    """Recalculate manifest.json for all files in golden_scanned."""
    manifest = {}
    if MANIFEST_PATH.exists():
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            manifest = json.load(f)

    for p in FIXTURES_DIR.rglob("*"):
        if p.is_file() and p.suffix.lower() in [".jpg", ".jpeg", ".png", ".pdf"]:
            # Relative to repo root
            rel_path = str(p.relative_to(REPO_ROOT)).replace("\\", "/")
            with open(p, "rb") as f:
                content = f.read()
                sha = hashlib.sha256(content).hexdigest()
                size = len(content)
            manifest[p.name] = {
                "path": rel_path,
                "sha256": sha,
                "size_bytes": size,
            }

    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=4)
    print(f"Manifest updated with {len(manifest)} files.")


def main():
    print(f"Starting synthetic generation with font: {FONT_PATH}")
    for idx, spec in enumerate(DOC_SPECS):
        out_path = FIXTURES_DIR / spec["filename"]
        out_path.parent.mkdir(parents=True, exist_ok=True)

        img, verbatim_text = render_document(spec, seed=1000 + idx)
        img.save(out_path, "PNG")
        print(f"Generated: {spec['filename']} ({img.size[0]}x{img.size[1]})")

        # Generate paired ground truth JSON
        json_path = out_path.with_suffix(".json")
        gt_data = {
            "docId": spec["doc_id"],
            "language": spec["lang"],
            "docType": spec["doc_type"],
            "status": "synthetic_directional_only",
            "provenance": "generated_source_text",
            "verified_by": "generator_v1",
            "seen_in_v6_tuning": False,
            "split": "synthetic",
            "groundTruthText": verbatim_text,
            "patientInfo": spec["patient_info"],
            "medications": spec["medications"],
            "labResults": spec["lab_results"],
        }
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(gt_data, f, indent=2, ensure_ascii=False)

    # Generate rotation ablation suite using the first Hindi document as clean baseline
    # Or render a clean English clinical prescription baseline
    print("Generating rotation ablation fixtures...")
    clean_base_canvas, _ = render_document(DOC_SPECS[0], seed=999)
    generate_rotation_ablation(clean_base_canvas, FIXTURES_DIR / "ablation")

    # Update manifest
    update_manifest()
    print("Synthetic generation and ablation suite completed successfully!")


if __name__ == "__main__":
    main()
