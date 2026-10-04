from __future__ import annotations

import io
import json
import math
import os
import shutil
from pathlib import Path
import fitz  # PyMuPDF
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FIXTURES_DIR = Path("d:/TECHROVER/health-vault/health-vault-backend/ai-service/tests/fixtures/golden_docs")
FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

def _draw_ecg_grid_and_waveform(width=600, height=200) -> Image.Image:
    img = Image.new("RGB", (width, height), color=(255, 245, 245))
    draw = ImageDraw.Draw(img)
    # 1mm grid
    for x in range(0, width, 10):
        draw.line([(x, 0), (x, height)], fill=(255, 220, 220), width=1)
    for y in range(0, height, 10):
        draw.line([(0, y), (width, y)], fill=(255, 220, 220), width=1)
    # 5mm major grid
    for x in range(0, width, 50):
        draw.line([(x, 0), (x, height)], fill=(255, 180, 180), width=1)
    for y in range(0, height, 50):
        draw.line([(0, y), (width, y)], fill=(255, 180, 180), width=1)
    
    # ECG waveform (P-QRS-T)
    points = []
    baseline = height // 2
    for x in range(width):
        t = (x % 100) / 100.0
        y = baseline
        if 0.15 <= t < 0.25:  # P wave
            y -= 15 * math.sin((t - 0.15) * math.pi / 0.1)
        elif 0.30 <= t < 0.33:  # Q wave
            y += 8 * math.sin((t - 0.30) * math.pi / 0.03)
        elif 0.33 <= t < 0.38:  # R wave
            y -= 65 * math.sin((t - 0.33) * math.pi / 0.05)
        elif 0.38 <= t < 0.42:  # S wave
            y += 18 * math.sin((t - 0.38) * math.pi / 0.04)
        elif 0.55 <= t < 0.75:  # T wave
            y -= 25 * math.sin((t - 0.55) * math.pi / 0.2)
        points.append((x, int(y)))
    draw.line(points, fill=(180, 0, 0), width=2)
    return img

def _draw_xray_sim(width=400, height=400) -> Image.Image:
    arr = np.zeros((height, width), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            # simulate lung fields
            cx1, cy1 = width * 0.35, height * 0.45
            cx2, cy2 = width * 0.65, height * 0.45
            d1 = math.hypot(x - cx1, (y - cy1) * 1.2)
            d2 = math.hypot(x - cx2, (y - cy2) * 1.2)
            val = 20
            if d1 < 90:
                val = int(255 - (d1 / 90) * 180)
            elif d2 < 90:
                val = int(255 - (d2 / 90) * 180)
            arr[y, x] = max(10, min(240, val))
    img = Image.fromarray(arr, mode="L").convert("RGB")
    draw = ImageDraw.Draw(img)
    draw.text((15, 15), "CHEST PA VIEW", fill=(255, 255, 255))
    return img

def _draw_echo_sim(width=400, height=300) -> Image.Image:
    img = Image.new("RGB", (width, height), color=(15, 15, 25))
    draw = ImageDraw.Draw(img)
    draw.arc([50, 20, width - 50, height * 1.5], 200, 340, fill=(100, 180, 220), width=3)
    draw.text((20, 20), "2D ECHOCARDIOGRAPHY - APICAL 4 CHAMBER", fill=(200, 240, 255))
    draw.text((20, 40), "EF: 60%  LVEDD: 46mm", fill=(200, 240, 255))
    return img

def generate_all():
    print("Generating Golden Fixtures in:", FIXTURES_DIR)

    # 1. Born Digital Text PDF
    doc = fitz.open()
    page = doc.new_page()
    content_p1 = """METRO HEALTHCARE CLINICAL LABORATORY
Patient Name: John Doe    Age: 45    Sex: Male    Date: 2026-03-15
Doctor: Dr. Sarah Jenkins    Ref ID: MH-2026-9921

COMPREHENSIVE METABOLIC PANEL
Test Name                 Result      Unit       Reference Range    Status
Fasting Blood Glucose     95          mg/dL      70 - 99            NORMAL
HbA1c                     5.4         %          4.0 - 5.6          NORMAL
Blood Urea Nitrogen       14          mg/dL      7 - 20             NORMAL
Serum Creatinine          0.9         mg/dL      0.6 - 1.2          NORMAL
Total Bilirubin           0.8         mg/dL      0.2 - 1.2          NORMAL
Serum Potassium           4.2         mmol/L     3.5 - 5.0          NORMAL

Impression: Metabolic profile is within normal clinical limits.
Dr. Sarah Jenkins, MD (Pathologist)
"""
    page.insert_text((50, 50), content_p1, fontsize=10)
    pdf_path = FIXTURES_DIR / "born_digital_text.pdf"
    doc.save(str(pdf_path))
    doc.close()

    gt_1 = {
        "documentType": "LAB_REPORT",
        "language": "english",
        "patientInfo": {"name": "John Doe", "age": 45, "gender": "MALE"},
        "doctorInfo": {"name": "Dr. Sarah Jenkins"},
        "hospitalInfo": {"name": "Metro Healthcare Clinical Laboratory"},
        "labResults": [
            {"testName": "Fasting Blood Glucose", "value": "95", "unit": "mg/dL", "status": "NORMAL"},
            {"testName": "HbA1c", "value": "5.4", "unit": "%", "status": "NORMAL"},
            {"testName": "Serum Creatinine", "value": "0.9", "unit": "mg/dL", "status": "NORMAL"},
        ],
        "groundTruthText": content_p1.strip()
    }
    with open(FIXTURES_DIR / "born_digital_text.json", "w") as f:
        json.dump(gt_1, f, indent=2)

    # 2. Scanned Report PDF (rendered to image and placed into PDF)
    img_page = Image.new("RGB", (800, 1100), color=(250, 250, 248))
    draw = ImageDraw.Draw(img_page)
    draw.text((60, 60), "CITY HOSPITAL - CLINICAL CONSULTATION NOTE", fill=(20, 20, 20))
    draw.text((60, 90), "Patient Name: Robert Miller   Age: 58   Sex: Male   Date: 2026-04-10", fill=(30, 30, 30))
    draw.text((60, 130), "Vitals: BP 130/85 mmHg, Pulse 76 bpm, SpO2 98%", fill=(30, 30, 30))
    draw.text((60, 170), "Diagnosis: Essential Hypertension, Dyslipidemia", fill=(30, 30, 30))
    draw.text((60, 210), "Rx:\n1. Tab Amlodipine 5mg - once daily morning\n2. Tab Atorvastatin 20mg - once daily night", fill=(20, 20, 40))
    
    # Add subtle rotation/skew to simulate scan
    img_page = img_page.rotate(1.0, resample=Image.BICUBIC, expand=False, fillcolor=(250, 250, 248))
    doc_scan = fitz.open()
    p = doc_scan.new_page(width=800, height=1100)
    buf = io.BytesIO()
    img_page.save(buf, format="JPEG", quality=85)
    p.insert_image(p.rect, stream=buf.getvalue())
    doc_scan.save(str(FIXTURES_DIR / "scanned_report.pdf"))
    doc_scan.close()

    gt_2 = {
        "documentType": "PRESCRIPTION",
        "language": "english",
        "patientInfo": {"name": "Robert Miller", "age": 58, "gender": "MALE"},
        "vitals": [{"parameter": "Blood Pressure", "systolic": 130, "diastolic": 85}, {"parameter": "SpO2", "value": 98}],
        "medications": [
            {"name": "Amlodipine 5mg", "dosage": "5mg", "frequency": "once daily"},
            {"name": "Atorvastatin 20mg", "dosage": "20mg", "frequency": "once daily"}
        ],
        "diagnosis": ["Essential Hypertension", "Dyslipidemia"]
    }
    with open(FIXTURES_DIR / "scanned_report.json", "w") as f:
        json.dump(gt_2, f, indent=2)

    # 3. Mixed PDF (Page 1 Born Digital, Page 2 Scanned Raster)
    doc_mixed = fitz.open()
    p1 = doc_mixed.new_page()
    p1.insert_text((50, 50), "APOLLO CLINIC DISCHARGE SUMMARY - PAGE 1\nPatient Name: Emily Clark   Age: 34   Sex: Female\nAdmission Date: 2026-05-01   Discharge Date: 2026-05-04\nDiagnosis: Acute Gastroenteritis with mild dehydration\nHospital Course: Patient admitted with vomiting and diarrhea. Rehydrated with IV fluids.", fontsize=11)
    
    p2 = doc_mixed.new_page(width=600, height=800)
    img_p2 = Image.new("RGB", (600, 800), color=(252, 252, 250))
    d2 = ImageDraw.Draw(img_p2)
    d2.text((50, 50), "DISCHARGE INSTRUCTIONS - PAGE 2 (SIGNED NOTE)", fill=(0, 0, 0))
    d2.text((50, 90), "Rx Medications on Discharge:\n1. Tab Ondansetron 4mg - tid as needed for nausea\n2. Tab Ofloxacin 200mg - bid for 5 days\n3. ORS sachet - 1 packet in 1 liter water", fill=(10, 10, 30))
    d2.text((50, 200), "Follow up in OPD after 5 days with Dr. R. Verma", fill=(0, 0, 0))
    buf2 = io.BytesIO()
    img_p2.save(buf2, format="JPEG", quality=80)
    p2.insert_image(p2.rect, stream=buf2.getvalue())
    doc_mixed.save(str(FIXTURES_DIR / "mixed_document.pdf"))
    doc_mixed.close()

    gt_3 = {
        "documentType": "DISCHARGE_SUMMARY",
        "pageCount": 2,
        "page1Routing": "pymupdf_direct",
        "page2Routing": "vision_ocr",
        "patientInfo": {"name": "Emily Clark", "age": 34, "gender": "FEMALE"},
        "diagnosis": ["Acute Gastroenteritis"],
        "medications": [
            {"name": "Ondansetron 4mg", "dosage": "4mg"},
            {"name": "Ofloxacin 200mg", "dosage": "200mg"}
        ]
    }
    with open(FIXTURES_DIR / "mixed_document.json", "w") as f:
        json.dump(gt_3, f, indent=2)

    # 4. Multi-Page Inpatient Medical Report (3 Pages)
    doc_multi = fitz.open()
    m_p1 = doc_multi.new_page()
    m_p1.insert_text((50, 50), "CITY GENERAL HOSPITAL - INPATIENT RECORD\nPatient: David Miller  Age: 62  Gender: Male  ID: P-90812\nAdmitted: 2026-06-10   Attending: Dr. Arthur Pendelton\nChief Complaint: Retrosternal chest tightness and exertional dyspnea.\nHistory: Patient reports 3 days of worsening chest pressure radiating to left arm.\nBaseline Vitals: BP 155/95 mmHg, HR 88 bpm, SpO2 96%, Temp 98.4 F.", fontsize=10)
    
    m_p2 = doc_multi.new_page()
    m_p2.insert_text((50, 50), "INPATIENT INVESTIGATIONS & LABS - PAGE 2\nTroponin I: 0.85 ng/mL (Reference: < 0.04) [HIGH - CRITICAL]\nCK-MB: 42 U/L (Reference: 0 - 25) [HIGH]\nTotal Cholesterol: 245 mg/dL (Reference: < 200) [HIGH]\nTriglycerides: 190 mg/dL (Reference: < 150) [HIGH]\nHDL: 38 mg/dL (Reference: > 40) [LOW]\nLDL: 169 mg/dL (Reference: < 100) [HIGH]\nSerum Creatinine: 1.1 mg/dL [NORMAL]", fontsize=10)

    m_p3 = doc_multi.new_page()
    m_p3.insert_text((50, 50), "DISCHARGE PLAN & TREATMENT - PAGE 3\nFinal Diagnosis: Acute Non-ST-Elevation Myocardial Infarction (NSTEMI), Hyperlipidemia\nCoronary Angiogram: 70% stenosis in Mid-LAD, stented successfully with DES.\nDischarge Medications:\n1. Tab Aspirin 75mg - once daily after lunch\n2. Tab Clopidogrel 75mg - once daily morning\n3. Tab Atorvastatin 40mg - once daily at bedtime\n4. Tab Metoprolol 25mg - twice daily with meals\nPlan: Cardiac rehabilitation OPD in 2 weeks.", fontsize=10)
    doc_multi.save(str(FIXTURES_DIR / "multi_page_inpatient.pdf"))
    doc_multi.close()

    gt_4 = {
        "documentType": "DISCHARGE_SUMMARY",
        "pageCount": 3,
        "patientInfo": {"name": "David Miller", "age": 62, "gender": "MALE"},
        "vitals": [{"parameter": "Blood Pressure", "systolic": 155, "diastolic": 95}],
        "criticalLabs": ["Troponin I"],
        "diagnosis": ["Acute Non-ST-Elevation Myocardial Infarction", "Hyperlipidemia"],
        "medications": [
            {"name": "Aspirin 75mg", "dosage": "75mg"},
            {"name": "Clopidogrel 75mg", "dosage": "75mg"},
            {"name": "Atorvastatin 40mg", "dosage": "40mg"},
            {"name": "Metoprolol 25mg", "dosage": "25mg"}
        ]
    }
    with open(FIXTURES_DIR / "multi_page_inpatient.json", "w") as f:
        json.dump(gt_4, f, indent=2)

    # 5. Abnormal Metabolic Panel Lab Report
    doc_lab = fitz.open()
    lp = doc_lab.new_page()
    lp_text = """EXCEL PATHOLOGY LABORATORIES
Patient: Rajesh Patel    Age: 52    Gender: Male    Date: 2026-07-02
Referred By: Dr. K. Mehta

DIABETES & RENAL MONITORING PANEL
Test Name                 Result      Unit       Reference Range    Flag
Fasting Blood Sugar       185         mg/dL      70 - 100           HIGH
Post Prandial Blood Sugar 260         mg/dL      100 - 140          HIGH
HbA1c                     8.2         %          4.0 - 5.6          HIGH
Estimated Average Glucose 189         mg/dL      70 - 126           HIGH
Serum Urea                38          mg/dL      15 - 45            NORMAL
Serum Creatinine          1.8         mg/dL      0.7 - 1.3          HIGH
eGFR                      42          mL/min     > 60               LOW
Microalbuminuria          85          mg/L       < 20               HIGH

Interpretation: Poorly controlled Type 2 Diabetes Mellitus with Stage 3 Diabetic Nephropathy.
"""
    lp.insert_text((50, 50), lp_text, fontsize=10)
    doc_lab.save(str(FIXTURES_DIR / "metabolic_panel.pdf"))
    doc_lab.close()

    gt_5 = {
        "documentType": "LAB_REPORT",
        "patientInfo": {"name": "Rajesh Patel", "age": 52, "gender": "MALE"},
        "abnormalFlags": {
            "Fasting Blood Sugar": {"val": "185", "flag": "HIGH"},
            "HbA1c": {"val": "8.2", "flag": "HIGH"},
            "Serum Creatinine": {"val": "1.8", "flag": "HIGH"},
            "eGFR": {"val": "42", "flag": "LOW"}
        }
    }
    with open(FIXTURES_DIR / "metabolic_panel.json", "w") as f:
        json.dump(gt_5, f, indent=2)

    # 6. Outpatient Prescription
    doc_rx = fitz.open()
    rx_p = doc_rx.new_page()
    rx_text = """DR. ARVIND SHARMA, MD (INTERNAL MEDICINE)
Reg No: MCI-45892    Shree Krishna Clinic, MG Road
Patient: Ananya Roy    Age: 29    Gender: Female    Date: 2026-07-15
Vitals: BP 118/75 mmHg, Pulse 72 bpm, Wt: 54 kg

Diagnosis: Acute Upper Respiratory Tract Infection, Allergic Rhinitis

Rx:
1. Tab Augmentin 625mg (Amoxicillin + Clavulanate) - 1 tab twice daily for 5 days after food
2. Tab Levocetirizine 5mg - 1 tab at bedtime for 5 days
3. Tab Paracetamol 650mg - 1 tab tid as needed for fever or body ache
4. Nasal Spray Fluticasone 50mcg - 2 sprays in each nostril once daily morning

Advice: Steam inhalation twice daily. Drink warm fluids. Review if fever persists after 3 days.
"""
    rx_p.insert_text((50, 50), rx_text, fontsize=10)
    doc_rx.save(str(FIXTURES_DIR / "outpatient_prescription.pdf"))
    doc_rx.close()

    gt_6 = {
        "documentType": "PRESCRIPTION",
        "patientInfo": {"name": "Ananya Roy", "age": 29, "gender": "FEMALE"},
        "vitals": [{"parameter": "Blood Pressure", "systolic": 118, "diastolic": 75}],
        "medications": [
            {"name": "Augmentin 625mg", "dosage": "625mg", "frequency": "twice daily"},
            {"name": "Levocetirizine 5mg", "dosage": "5mg", "frequency": "at bedtime"},
            {"name": "Paracetamol 650mg", "dosage": "650mg", "frequency": "tid"},
            {"name": "Fluticasone 50mcg", "dosage": "50mcg", "frequency": "once daily"}
        ]
    }
    with open(FIXTURES_DIR / "outpatient_prescription.json", "w") as f:
        json.dump(gt_6, f, indent=2)

    # 7. Handwritten Simulated Clinical Note
    doc_hw = fitz.open()
    hw_p = doc_hw.new_page()
    hw_text = """CLINICAL PROGRESS NOTE (OPD)
Date: 2026-08-01   Pt: Suresh Kumar   Age: 48 M
Complaints: c/o epigastric burning pain since 2 wks, aggravates on empty stomach.
O/E: Abdomen soft, mild epigastric tenderness. No organomegaly.
Imp: Acid Peptic Disease (GERD / Gastritis)
Plan:
- Tab Pantoprazole 40mg od (before breakfast) x 4 wks
- Syrup Sucralfate 10ml tid (1 hr before meals) x 2 wks
- Lifestyle: Avoid spicy food, tea/coffee on empty stomach.
Dr. Verma (Sign)
"""
    hw_p.insert_text((50, 50), hw_text, fontsize=10)
    doc_hw.save(str(FIXTURES_DIR / "handwritten_note.pdf"))
    doc_hw.close()

    # 8. Hospital Discharge Summary
    doc_ds = fitz.open()
    ds_p = doc_ds.new_page()
    ds_text = """MAX SUPER SPECIALITY HOSPITAL
DISCHARGE SUMMARY
Patient Name: Meera Nair     Age: 65 Years     Gender: Female     IPD No: 40912
Admission Date: 2026-07-20                  Discharge Date: 2026-07-25
Consultant: Dr. Ramesh Iyer (Cardiology)

Diagnosis: Chronic Heart Failure (NYHA Class II), Dilated Cardiomyopathy
Hospital Course: Patient admitted with bilateral pedal edema and orthopnea. Diuresed with IV Furosemide with symptomatic relief. 2D Echo showed LVEF 35%. Creatinine remained stable at 1.0 mg/dL.

Discharge Medications:
1. Tab Sacubitril / Valsartan 50mg - 1 tab twice daily
2. Tab Spironolactone 25mg - 1 tab once daily morning
3. Tab Dapagliflozin 10mg - 1 tab once daily morning
4. Tab Torsemide 10mg - 1 tab once daily morning

Dietary Advice: Strict salt restriction (<2g/day), Fluid intake restricted to 1.5 Liters/day.
Follow-up: Cardiology OPD after 10 days with Serum Electrolytes and Creatinine.
"""
    ds_p.insert_text((50, 50), ds_text, fontsize=10)
    doc_ds.save(str(FIXTURES_DIR / "hospital_discharge.pdf"))
    doc_ds.close()

    # 9. Hospital Bill / Invoice
    doc_bill = fitz.open()
    bill_p = doc_bill.new_page()
    bill_text = """FORTIS HEALTHCARE LIMITED - FINAL INPATIENT BILL
Bill No: BILL-2026-0881    Date: 2026-07-25    IP No: IP-7721
Patient: Vikram Singhania  Age: 55 M           Room: Deluxe Bed 402

ITEMIZED CHARGES BREAKDOWN
Service Description         Qty    Rate (INR)    Amount (INR)
Room Charges (5 Days)        5      6,000.00      30,000.00
Nursing & RMO Care           5      1,500.00       7,500.00
ICU Monitoring (1 Day)       1     12,000.00      12,000.00
Doctor Visit Fees           10      1,200.00      12,000.00
Laboratory Investigations    1     14,500.00      14,500.00
Radiology & Ultrasound       1      6,800.00       6,800.00
Pharmacy & Consumables       1     18,450.00      18,450.00

Subtotal:                                       1,01,250.00
Discount:                                          2,500.00
TPA Insurance Settlement (Star Health):           80,000.00
Net Amount Payable by Patient:                    18,750.00
Status: PAID IN FULL
"""
    bill_p.insert_text((50, 50), bill_text, fontsize=9.5)
    doc_bill.save(str(FIXTURES_DIR / "hospital_bill.pdf"))
    doc_bill.close()

    # 10. ECG Report with Waveform
    doc_ecg = fitz.open()
    ecg_p = doc_ecg.new_page()
    ecg_p.insert_text((50, 40), "CARDIOLOGY DIAGNOSTIC CENTER - 12 LEAD ECG REPORT\nPatient: Harold Finch   Age: 59   Sex: Male   Date: 2026-08-10\nHeart Rate: 72 bpm   PR Interval: 160 ms   QRS Duration: 88 ms   QT/QTc: 390/420 ms\nRhythm: Normal Sinus Rhythm. No acute ST-T elevation or depression.", fontsize=10)
    # Insert ECG waveform image
    ecg_img = _draw_ecg_grid_and_waveform(500, 160)
    ecg_buf = io.BytesIO()
    ecg_img.save(ecg_buf, format="PNG")
    ecg_p.insert_image(fitz.Rect(50, 120, 550, 280), stream=ecg_buf.getvalue())
    ecg_p.insert_text((50, 300), "Conclusion: Normal 12-Lead Electrocardiogram.\nReporting Cardiologist: Dr. H. Vance, MD, DM", fontsize=10)
    doc_ecg.save(str(FIXTURES_DIR / "ecg_report.pdf"))
    doc_ecg.close()

    # 11. X-Ray Report with Radiology Image
    doc_xray = fitz.open()
    xray_p = doc_xray.new_page()
    xray_p.insert_text((50, 40), "ADVANCED IMAGING & DIAGNOSTICS - CHEST RADIOLOGY\nPatient: Robert Downey   Age: 44   Sex: Male   Date: 2026-08-12\nExamination: CHEST PA VIEW\nFindings: Both lung fields appear clear without focal airspace consolidation, pleural effusion, or pneumothorax.\nCardiothoracic ratio is within normal limits. Bony thorax and soft tissues unremarkable.", fontsize=10)
    xray_img = _draw_xray_sim(250, 250)
    xray_buf = io.BytesIO()
    xray_img.save(xray_buf, format="PNG")
    xray_p.insert_image(fitz.Rect(180, 130, 420, 370), stream=xray_buf.getvalue())
    xray_p.insert_text((50, 390), "Impression: Normal Chest X-Ray Study.\nDr. Clara Oswald, MD (Consultant Radiologist)", fontsize=10)
    doc_xray.save(str(FIXTURES_DIR / "xray_report.pdf"))
    doc_xray.close()

    # 12. Echo Ultrasound Report
    doc_echo = fitz.open()
    echo_p = doc_echo.new_page()
    echo_p.insert_text((50, 40), "ECHOCARDIOGRAPHY REPORT (TTE)\nPatient: Bruce Wayne   Age: 46 M   Date: 2026-08-14\nLVEF: 60%   LVEDD: 46 mm   LVESD: 28 mm   LA Diameter: 34 mm\nFindings: Normal left ventricular size and systolic function. No regional wall motion abnormality. Valves structurally normal.", fontsize=10)
    echo_img = _draw_echo_sim(360, 200)
    echo_buf = io.BytesIO()
    echo_img.save(echo_buf, format="PNG")
    echo_p.insert_image(fitz.Rect(120, 120, 480, 320), stream=echo_buf.getvalue())
    echo_p.insert_text((50, 340), "Impression: Normal Transthoracic Echocardiogram. Normal LV Systolic Function.", fontsize=10)
    doc_echo.save(str(FIXTURES_DIR / "echo_report.pdf"))
    doc_echo.close()

    # 13. Growth Chart / Graph Report
    doc_graph = fitz.open()
    g_p = doc_graph.new_page()
    g_p.insert_text((50, 40), "PEDIATRIC ENDOCRINOLOGY - GROWTH & STATURE MONITORING\nChild Name: Leo Das   Age: 8 Years   Gender: Male   Date: 2026-08-15\nHeight: 128 cm (50th percentile)   Weight: 26 kg (45th percentile)   BMI: 15.8 kg/m2", fontsize=10)
    # create trend graph
    g_img = Image.new("RGB", (450, 180), color=(255, 255, 255))
    g_draw = ImageDraw.Draw(g_img)
    g_draw.line([(40, 150), (420, 150)], fill=(100, 100, 100), width=2)
    g_draw.line([(40, 20), (40, 150)], fill=(100, 100, 100), width=2)
    pts = [(40, 140), (100, 120), (180, 95), (260, 75), (340, 50), (400, 35)]
    g_draw.line(pts, fill=(0, 102, 204), width=3)
    for p in pts:
        g_draw.ellipse([p[0]-3, p[1]-3, p[0]+3, p[1]+3], fill=(204, 0, 0))
    g_buf = io.BytesIO()
    g_img.save(g_buf, format="PNG")
    g_p.insert_image(fitz.Rect(80, 110, 520, 290), stream=g_buf.getvalue())
    g_p.insert_text((50, 310), "Interpretation: Linear growth velocity is normal along the 50th percentile curve.", fontsize=10)
    doc_graph.save(str(FIXTURES_DIR / "growth_chart.pdf"))
    doc_graph.close()

    # 14. Bordered Table Report
    doc_bt = fitz.open()
    bt_p = doc_bt.new_page()
    bt_text = """HEMATOLOGY COMPLETE BLOOD COUNT (CBC)
Patient: Sneha Gupta   Age: 32 F   Date: 2026-08-18

+----------------------+---------+------------+-----------------+----------+
| Parameter            | Result  | Unit       | Reference Range | Status   |
+----------------------+---------+------------+-----------------+----------+
| Hemoglobin           | 11.2    | g/dL       | 12.0 - 15.5     | LOW      |
| Total WBC Count      | 7,200   | /mcL       | 4,500 - 11,000  | NORMAL   |
| RBC Count            | 4.1     | mil/mcL    | 3.8 - 5.2       | NORMAL   |
| Platelet Count       | 240,000 | /mcL       | 150k - 450k     | NORMAL   |
| Hematocrit (PCV)     | 34.0    | %          | 37.0 - 48.0     | LOW      |
| MCV                  | 76.5    | fL         | 80.0 - 96.0     | LOW      |
| MCH                  | 24.2    | pg         | 27.0 - 33.0     | LOW      |
+----------------------+---------+------------+-----------------+----------+
Impression: Microcytic Hypochromic Anemia, consistent with Iron Deficiency.
"""
    bt_p.insert_text((50, 40), bt_text, fontsize=9.5)
    doc_bt.save(str(FIXTURES_DIR / "bordered_table.pdf"))
    doc_bt.close()

    # 15. Borderless Table Report
    doc_blt = fitz.open()
    blt_p = doc_blt.new_page()
    blt_text = """RENAL FUNCTION TEST (RFT) - BORDERLESS FORMAT
Patient: Anand Kulkarni   Age: 64 M   Date: 2026-08-20

Test Parameter         Observed Value     Biological Ref Range    Units
Blood Urea Nitrogen    22                 8 - 23                  mg/dL
Serum Creatinine       1.15               0.70 - 1.30             mg/dL
Uric Acid              6.8                3.5 - 7.2               mg/dL
Sodium (Na+)           139                136 - 145               mmol/L
Potassium (K+)         4.4                3.5 - 5.1               mmol/L
Chloride (Cl-)         102                98 - 107                mmol/L
Calcium                9.3                8.8 - 10.2              mg/dL

Doctor Remarks: Renal biochemical parameters are within normal physiological limits.
"""
    blt_p.insert_text((50, 40), blt_text, fontsize=10)
    doc_blt.save(str(FIXTURES_DIR / "borderless_table.pdf"))
    doc_blt.close()

    # 16. Multi-Visual Assets on Single Page
    doc_mva = fitz.open()
    mva_p = doc_mva.new_page()
    mva_p.insert_text((50, 30), "INTEGRATED CARDIAC EVALUATION REPORT\nPatient: Clark Kent   Age: 38 M   Date: 2026-08-22", fontsize=10)
    mva_p.insert_image(fitz.Rect(50, 70, 300, 200), stream=ecg_buf.getvalue())
    mva_p.insert_image(fitz.Rect(320, 70, 550, 200), stream=echo_buf.getvalue())
    mva_p.insert_text((50, 220), "Summary Table of Key Measurements:\nHR: 72 bpm | LVEF: 60% | QTc: 420 ms | Wall Motion: Normal\nCardiologist Sign: Dr. Bruce Wayne, MD", fontsize=10)
    doc_mva.save(str(FIXTURES_DIR / "multi_asset_page.pdf"))
    doc_mva.close()

    # 17. Multi-Report Batch in Single Upload (Lipid + Thyroid)
    doc_batch = fitz.open()
    b_p1 = doc_batch.new_page()
    b_p1.insert_text((50, 40), "METROPOLIS LABS - SECTION 1: LIPID PROFILE\nPatient: Diana Prince   Age: 35 F   Date: 2026-08-25\nTotal Cholesterol: 180 mg/dL (<200 NORMAL)\nTriglycerides: 110 mg/dL (<150 NORMAL)\nHDL Cholesterol: 55 mg/dL (>50 NORMAL)\nLDL Cholesterol: 103 mg/dL (<100 BORDERLINE)", fontsize=10)
    b_p2 = doc_batch.new_page()
    b_p2.insert_text((50, 40), "METROPOLIS LABS - SECTION 2: THYROID FUNCTION TEST\nPatient: Diana Prince   Age: 35 F   Date: 2026-08-25\nFree T3: 3.1 pg/mL (2.0 - 4.4 NORMAL)\nFree T4: 1.2 ng/dL (0.8 - 1.8 NORMAL)\nTSH: 2.45 uIU/mL (0.4 - 4.2 NORMAL)\nOverall Impression: Euthyroid status.", fontsize=10)
    doc_batch.save(str(FIXTURES_DIR / "multi_report_batch.pdf"))
    doc_batch.close()

    NIRMALA_FONT = r"C:\Windows\Fonts\Nirmala.ttc"

    # 18. Gujarati Prescription (gu)
    doc_gu = fitz.open()
    gu_p = doc_gu.new_page()
    gu_text = """ડૉ. પંકજ પટેલ (જનરલ ફિઝિશિયન)
દર્દીનું નામ: મંજુલાબેન શાહ    ઉંમર: ૬૨ વર્ષ    સ્ત્રી    તારીખ: ૨૦૨૬-૦૮-૨૬
નિદાન: ડાયાબિટીસ અને હાઇપરટેન્શન (Diabetes & Hypertension)

દવાઓની યાદી:
૧. Tab Metformin 500mg - ૧ ગોળી સવારે અને સાંજે જમ્યા પછી
૨. Tab Telmisartan 40mg - ૧ ગોળી સવારે ભૂખ્યા પેટે
૩. Tab Atorvastatin 10mg - ૧ ગોળી રાત્રે સુતા પહેલા

સલાહ: મીઠું અને ખાંડ ઓછી લેવી. દરરોજ ૩૦ મિનિટ ચાલવું.
"""
    if os.path.exists(NIRMALA_FONT):
        gu_p.insert_font(fontname="nirmala", fontfile=NIRMALA_FONT)
        gu_p.insert_text((50, 40), gu_text, fontname="nirmala", fontsize=10)
    else:
        gu_p.insert_text((50, 40), gu_text, fontsize=10)
    doc_gu.save(str(FIXTURES_DIR / "gujarati_prescription.pdf"))
    doc_gu.close()

    gt_18 = {
        "language": "gujarati",
        "patientInfo": {"name": "મંજુલાબેન શાહ", "age": 62, "gender": "FEMALE"},
        "medications": [
            {"name": "Metformin 500mg", "dosage": "500mg"},
            {"name": "Telmisartan 40mg", "dosage": "40mg"},
            {"name": "Atorvastatin 10mg", "dosage": "10mg"}
        ]
    }
    with open(FIXTURES_DIR / "gujarati_prescription.json", "w") as f:
        json.dump(gt_18, f, indent=2)

    # 19. Hindi Prescription (hi)
    doc_hi = fitz.open()
    hi_p = doc_hi.new_page()
    hi_text = """डॉ. आलोक कुमार (हृदय रोग विशेषज्ञ)
मरीज का नाम: रामेश्वर प्रसाद    उम्र: ५५ वर्ष    पुरुष    दिनांक: २०२६-०८-२७
निदान: उच्च रक्तचाप (Hypertension), सीने में दर्द

दवाइयां (Rx):
१. Tab Amlodipine 5mg - १ गोली सुबह नाश्ते के बाद
२. Tab Metoprolol 50mg - १ गोली सुबह भोजन के बाद
३. Tab Sorbitrate 5mg - सीने में दर्द होने पर जीभ के नीचे रखें

परामर्श: हल्का भोजन करें, नमक कम लें, नियमित रक्तचाप की जांच करवाएं।
"""
    if os.path.exists(NIRMALA_FONT):
        hi_p.insert_font(fontname="nirmala", fontfile=NIRMALA_FONT)
        hi_p.insert_text((50, 40), hi_text, fontname="nirmala", fontsize=10)
    else:
        hi_p.insert_text((50, 40), hi_text, fontsize=10)
    doc_hi.save(str(FIXTURES_DIR / "hindi_prescription.pdf"))
    doc_hi.close()

    gt_19 = {
        "language": "hindi",
        "patientInfo": {"name": "रामेश्वर प्रसाद", "age": 55, "gender": "MALE"},
        "medications": [
            {"name": "Amlodipine 5mg", "dosage": "5mg"},
            {"name": "Metoprolol 50mg", "dosage": "50mg"},
            {"name": "Sorbitrate 5mg", "dosage": "5mg"}
        ]
    }
    with open(FIXTURES_DIR / "hindi_prescription.json", "w") as f:
        json.dump(gt_19, f, indent=2)

    # 20. Tamil Prescription (ta)
    doc_ta = fitz.open()
    ta_p = doc_ta.new_page()
    ta_text = """டாக்டர் கே. முருகன் (பொது மருத்துவர்)
நோயாளி பெயர்: செல்வி சுந்தரி    வயது: 40    பெண்    தேதி: 2026-08-28
நோய் கண்டறிதல்: காய்ச்சல் மற்றும் சளி (Viral Fever & Pharyngitis)

மருந்துகள் (Rx):
1. Tab Paracetamol 650mg - 1 மாத்திரை தேவைப்படும் போது (காய்ச்சலுக்கு)
2. Tab Azithromycin 500mg - 1 மாத்திரை தினமும் ஒரு முறை 3 நாட்களுக்கு
3. Tab Cetirizine 10mg - 1 மாத்திரை இரவு உணவுக்குப் பின்

ஆலோசனை: வெந்நீர் குடிக்கவும், ஓய்வு எடுக்கவும்.
"""
    if os.path.exists(NIRMALA_FONT):
        ta_p.insert_font(fontname="nirmala", fontfile=NIRMALA_FONT)
        ta_p.insert_text((50, 40), ta_text, fontname="nirmala", fontsize=10)
    else:
        ta_p.insert_text((50, 40), ta_text, fontsize=10)
    doc_ta.save(str(FIXTURES_DIR / "tamil_prescription.pdf"))
    doc_ta.close()

    gt_20 = {
        "language": "tamil",
        "patientInfo": {"name": "செல்வி சுந்தரி", "age": 40, "gender": "FEMALE"},
        "medications": [
            {"name": "Paracetamol 650mg", "dosage": "650mg"},
            {"name": "Azithromycin 500mg", "dosage": "500mg"},
            {"name": "Cetirizine 10mg", "dosage": "10mg"}
        ]
    }
    with open(FIXTURES_DIR / "tamil_prescription.json", "w") as f:
        json.dump(gt_20, f, indent=2)

    # 21. Mixed Language Document (Hindi + English)
    doc_bi = fitz.open()
    bi_p = doc_bi.new_page()
    bi_text = """MEDANTA MEDICLINIC - BILINGUAL CONSULTATION REPORT
Patient Name: Mohan Lal Verma    Age: 60 Years    Gender: Male
Date: 2026-08-30    Consultant: Dr. Neha Saxena

Chief Complaints / मुख्य शिकायतें:
- Mild shortness of breath on exertion (सांस लेने में हल्की तकलीफ)
- Joint pain in both knees (दोनों घुटनों में दर्द)

Clinical Findings & Vitals / शारीरिक परीक्षण:
- BP: 135/85 mmHg    Pulse: 74 bpm    SpO2: 97% on room air

Prescription / दवाएं:
1. Tab Glucosamine Sulfate 500mg - twice daily after food
2. Tab Calcium + Vitamin D3 500mg - once daily after lunch
3. Tab Pantoprazole 40mg - once daily before breakfast

डॉक्टर की सलाह (Doctor Advice):
- Avoid lifting heavy weights (भारी वजन न उठाएं)
- Knee strengthening exercises daily (रोजाना घुटनों का व्यायाम करें)
"""
    if os.path.exists(NIRMALA_FONT):
        bi_p.insert_font(fontname="nirmala", fontfile=NIRMALA_FONT)
        bi_p.insert_text((50, 40), bi_text, fontname="nirmala", fontsize=9.5)
    else:
        bi_p.insert_text((50, 40), bi_text, fontsize=9.5)
    doc_bi.save(str(FIXTURES_DIR / "bilingual_mixed.pdf"))
    doc_bi.close()

    # Link / Copy Real Document Fixtures if available
    real_scan_src = Path(r"d:\TECHROVER\health-vault\health-vault-backend\tmp\temp_1789467758092.pdf")
    if real_scan_src.exists():
        shutil.copy(real_scan_src, FIXTURES_DIR / "real_4page_scanned.pdf")
        print("Copied real 4-page scanned PDF.")

    real_digital_src = Path(r"d:\TECHROVER\health-vault\health-vault-backend\uploads\temp\8fa643ab-0c65-4bad-bb72-2273ddfe4f41.pdf")
    if real_digital_src.exists():
        shutil.copy(real_digital_src, FIXTURES_DIR / "real_6page_digital.pdf")
        print("Copied real 6-page digital PDF.")

    print(f"Generated 21 Golden Document Fixtures in {FIXTURES_DIR}")

if __name__ == "__main__":
    generate_all()
