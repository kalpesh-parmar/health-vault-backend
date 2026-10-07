"""Setup and execute the 30-document evaluation gate corpus locally.

Follows strict PHI compliance:
- Files generated/copied to tests/fixtures/validation_eval_corpus/ (ignored by git and docker)
- No PHI or private text logged
- Computes exact Confusion Matrix, Sensitivity, Specificity, and Latency percentiles
"""
from __future__ import annotations

import asyncio
import io
import os
import shutil
import time
from typing import Any

import fitz  # PyMuPDF
import numpy as np
from PIL import Image, ImageDraw

from app.modules.validation.service import MedicalValidationService
from app.settings import Settings

CORPUS_DIR = "tests/fixtures/validation_eval_corpus"


def ensure_dir(d: str) -> None:
    os.makedirs(d, exist_ok=True)


def create_synthetic_pdf(filepath: str, pages_text: list[str]) -> None:
    """Create a digital PDF with embedded text on each page."""
    doc = fitz.open()
    for text in pages_text:
        page = doc.new_page(width=595, height=842)  # A4
        page.insert_text((50, 80), text, fontsize=12)
    doc.save(filepath)
    doc.close()


def create_synthetic_image(filepath: str, text_lines: list[str], bg_color: str = "white") -> None:
    """Create a synthetic rendered document image."""
    img = Image.new("RGB", (800, 1000), color=bg_color)
    draw = ImageDraw.Draw(img)
    y = 50
    for line in text_lines:
        draw.text((50, y), line, fill="black")
        y += 30
    img.save(filepath)


def populate_corpus() -> list[dict[str, Any]]:
    ensure_dir(CORPUS_DIR)
    manifest: list[dict[str, Any]] = []

    # -------------------------------------------------------------
    # 1. Prescriptions (n=5) -> Expected: MEDICAL
    # -------------------------------------------------------------
    # 1.1 lab_1_.jpeg
    p1 = os.path.join(CORPUS_DIR, "01_rx_lab_1.jpeg")
    src1 = "tests/fixtures/golden_docs/lab_1_.jpeg"
    if os.path.exists(src1):
        shutil.copyfile(src1, p1)
    else:
        create_synthetic_image(p1, ["Rx CLINICAL PRESCRIPTION", "Dr. A. Sharma MBBS", "Tab Amoxicillin 500mg TDS", "Syp Paracetamol 10ml"])
    manifest.append({"id": "rx_01", "file": p1, "expected": True, "category": "Prescription"})

    # 1.2 Gujarati prescription
    p2 = os.path.join(CORPUS_DIR, "02_rx_gujarati.png")
    src2 = "tests/fixtures/golden_scanned/gu/gu_02_prescription.png"
    if os.path.exists(src2):
        shutil.copyfile(src2, p2)
    else:
        create_synthetic_image(p2, ["GUJARATI CLINICAL PRESCRIPTION", "Dr. Patel MBBS", "Tab Paracetamol 500mg", "Rx: Tab Metformin 500mg"])
    manifest.append({"id": "rx_02", "file": p2, "expected": True, "category": "Prescription"})

    # 1.3 Hindi clinic note
    p3 = os.path.join(CORPUS_DIR, "03_rx_hindi.png")
    src3 = "tests/fixtures/golden_scanned/hi/hi_01_prescription.png"
    if os.path.exists(src3):
        shutil.copyfile(src3, p3)
    else:
        create_synthetic_image(p3, ["चिकित्सा परामर्श पर्ची (Prescription)", "डॉ. आर. के. वर्मा", "दवा: पैरासिटामोल 650mg"])
    manifest.append({"id": "rx_03", "file": p3, "expected": True, "category": "Prescription"})

    # 1.4 Printed outpatient Rx 1
    p4 = os.path.join(CORPUS_DIR, "04_rx_outpatient_1.pdf")
    src4 = "tests/fixtures/golden_docs/outpatient_prescription.pdf"
    if os.path.exists(src4):
        shutil.copyfile(src4, p4)
    else:
        create_synthetic_pdf(p4, ["OUTPATIENT CLINIC RECORD\nDoctor: Dr. Mehta MD\nRx:\n1. Tab Metformin 500mg OD\n2. Tab Telmisartan 40mg OD\nAdvise: Blood sugar fasting"])
    manifest.append({"id": "rx_04", "file": p4, "expected": True, "category": "Prescription"})

    # 1.5 Printed outpatient Rx 2
    p5 = os.path.join(CORPUS_DIR, "05_rx_outpatient_2.png")
    src5 = "tests/fixtures/golden_scanned/hi/hi_02_prescription.png"
    if os.path.exists(src5):
        shutil.copyfile(src5, p5)
    else:
        create_synthetic_image(p5, ["APOLLO CLINIC OUTPATIENT PRESCRIPTION", "Dr. S. Nair MD", "Rx: Tab Azithromycin 500mg OD x 3 days", "Tab Levocetirizine 5mg HS"])
    manifest.append({"id": "rx_05", "file": p5, "expected": True, "category": "Prescription"})

    # -------------------------------------------------------------
    # 2. Lab Reports (n=5) -> Expected: MEDICAL
    # -------------------------------------------------------------
    # 2.1 5069200904.pdf
    p6 = os.path.join(CORPUS_DIR, "06_lab_5069200904.pdf")
    src6 = "tests/fixtures/golden_docs/5069200904.pdf"
    if os.path.exists(src6):
        shutil.copyfile(src6, p6)
    else:
        create_synthetic_pdf(p6, ["PATHOLOGY LABORATORY REPORT\nTest: Complete Blood Count\nHemoglobin: 13.5 g/dL (12-16)\nWBC: 6,800 /mcL\nPlatelets: 220,000 /mcL"])
    manifest.append({"id": "lab_01", "file": p6, "expected": True, "category": "Lab Report"})

    # 2.2 60300505154.pdf
    p7 = os.path.join(CORPUS_DIR, "07_lab_60300505154.pdf")
    src7 = "tests/fixtures/golden_docs/60300505154.pdf"
    if os.path.exists(src7):
        shutil.copyfile(src7, p7)
    else:
        create_synthetic_pdf(p7, ["DIAGNOSTIC LAB REPORT\nBiochemistry Panel\nSerum Creatinine: 0.9 mg/dL\nBlood Urea Nitrogen: 14 mg/dL\nSerum Bilirubin: 0.8 mg/dL"])
    manifest.append({"id": "lab_02", "file": p7, "expected": True, "category": "Lab Report"})

    # 2.3 CBC test panel
    p8 = os.path.join(CORPUS_DIR, "08_lab_cbc.png")
    src8 = "tests/fixtures/golden_scanned/hi/hi_03_lab_report.png"
    if os.path.exists(src8):
        shutil.copyfile(src8, p8)
    else:
        create_synthetic_image(p8, ["HAEMATOLOGY TEST REPORT", "Complete Hemogram (CBC)", "RBC Count: 4.8 million/uL", "Neutrophils: 60%", "Lymphocytes: 32%"])
    manifest.append({"id": "lab_03", "file": p8, "expected": True, "category": "Lab Report"})

    # 2.4 Urine routine / table
    p9 = os.path.join(CORPUS_DIR, "09_lab_urine_table.png")
    src9 = "tests/fixtures/golden_scanned/hi/hi_04_lab_table.png"
    if os.path.exists(src9):
        shutil.copyfile(src9, p9)
    else:
        create_synthetic_image(p9, ["URINE ROUTINE & MICROSCOPY REPORT", "Color: Pale Yellow", "Sugar: Nil", "Protein: Trace", "Pus Cells: 2-3 /HPF"])
    manifest.append({"id": "lab_04", "file": p9, "expected": True, "category": "Lab Report"})

    # 2.5 Metabolic panel
    p10 = os.path.join(CORPUS_DIR, "10_lab_metabolic.pdf")
    src10 = "tests/fixtures/golden_docs/metabolic_panel.pdf"
    if os.path.exists(src10):
        shutil.copyfile(src10, p10)
    else:
        create_synthetic_pdf(p10, ["COMPREHENSIVE METABOLIC PANEL\nFasting Blood Glucose: 98 mg/dL\nHbA1c: 5.6%\nTotal Cholesterol: 185 mg/dL\nTriglycerides: 140 mg/dL"])
    manifest.append({"id": "lab_05", "file": p10, "expected": True, "category": "Lab Report"})

    # -------------------------------------------------------------
    # 3. Diagnostic Imaging (n=3) -> Expected: MEDICAL
    # -------------------------------------------------------------
    # 3.1 Body scan report
    p11 = os.path.join(CORPUS_DIR, "11_imaging_body_scan.pdf")
    src11 = "tests/fixtures/golden_docs/body_scan_report.pdf"
    if os.path.exists(src11):
        shutil.copyfile(src11, p11)
    else:
        create_synthetic_pdf(p11, ["DEPARTMENT OF RADIOLOGY & IMAGING\nCT SCAN WHOLE BODY\nClinical Indication: Routine follow up\nFindings: Visualized lung fields clear. No focal lesion.\nImpression: Normal study."])
    manifest.append({"id": "img_01", "file": p11, "expected": True, "category": "Diagnostic Imaging"})

    # 3.2 Ultrasound abdomen
    p12 = os.path.join(CORPUS_DIR, "12_imaging_ultrasound.pdf")
    src12 = "tests/fixtures/golden_docs/echo_report.pdf"
    if os.path.exists(src12):
        shutil.copyfile(src12, p12)
    else:
        create_synthetic_pdf(p12, ["ULTRASOUND ABDOMEN & PELVIS\nLiver is normal in size and echotexture.\nGallbladder is thin-walled, no calculi.\nSpleen and pancreas unremarkable.\nImpression: Normal abdominal ultrasound."])
    manifest.append({"id": "img_02", "file": p12, "expected": True, "category": "Diagnostic Imaging"})

    # 3.3 Chest X-ray
    p13 = os.path.join(CORPUS_DIR, "13_imaging_xray.pdf")
    src13 = "tests/fixtures/golden_docs/xray_report.pdf"
    if os.path.exists(src13):
        shutil.copyfile(src13, p13)
    else:
        create_synthetic_pdf(p13, ["X-RAY CHEST PA VIEW\nCardiac silhouette within normal limits.\nCostophrenic angles sharp. No active parenchymal lesion.\nImpression: Clear lung fields."])
    manifest.append({"id": "img_03", "file": p13, "expected": True, "category": "Diagnostic Imaging"})

    # -------------------------------------------------------------
    # 4. Discharge Summaries (n=2) -> Expected: MEDICAL
    # -------------------------------------------------------------
    # 4.1 Discharge Summary multi-page 1
    p14 = os.path.join(CORPUS_DIR, "14_discharge_hospital.pdf")
    src14 = "tests/fixtures/golden_docs/hospital_discharge.pdf"
    if os.path.exists(src14):
        shutil.copyfile(src14, p14)
    else:
        create_synthetic_pdf(p14, [
            "HOSPITAL DISCHARGE SUMMARY\nPatient Name: John Doe\nAdmission Date: 12/01/2026\nDischarge Date: 16/01/2026\nDiagnosis: Acute Bronchitis",
            "Hospital Course & Treatment:\nIV fluids, Antibiotic therapy, Nebulization\nDischarge Medications:\n1. Tab Cefuroxime 500mg BD x 5 days\nCondition at discharge: Stable",
        ])
    manifest.append({"id": "dis_01", "file": p14, "expected": True, "category": "Discharge Summary"})

    # 4.2 Discharge Summary 2
    p15 = os.path.join(CORPUS_DIR, "15_discharge_inpatient.png")
    src15 = "tests/fixtures/golden_scanned/hi/hi_05_discharge.png"
    if os.path.exists(src15):
        shutil.copyfile(src15, p15)
    else:
        create_synthetic_image(p15, ["CITY CARE HOSPITAL INPATIENT DISCHARGE SUMMARY", "Final Diagnosis: Acute Gastroenteritis with mild dehydration", "Discharge Advice: ORS, Tab Pantoprazole 40mg OD"])
    manifest.append({"id": "dis_02", "file": p15, "expected": True, "category": "Discharge Summary"})

    # -------------------------------------------------------------
    # 5. Non-Medical Utility Bills (n=3) -> Expected: NON_MEDICAL
    # -------------------------------------------------------------
    # 5.1 Electricity Bill
    p16 = os.path.join(CORPUS_DIR, "16_bill_electricity.pdf")
    create_synthetic_pdf(p16, ["STATE ELECTRICITY DISTRIBUTION CO. LTD.\nConsumer No: 0823491823\nBilling Period: 01/09/2026 - 30/09/2026\nMeter Reading: 4520 kWh\nTotal Units Consumed: 340\nEnergy Charges: $52.40\nFuel Surcharge: $4.10\nTotal Amount Payable: $56.50\nDue Date: 15/10/2026"])
    manifest.append({"id": "bill_01", "file": p16, "expected": False, "category": "Non-Medical Utility Bill"})

    # 5.2 Broadband Invoice
    p17 = os.path.join(CORPUS_DIR, "17_bill_broadband.pdf")
    create_synthetic_pdf(p17, ["FIBERNET TELECOM INVOICE\nAccount Number: FT-882910\nPlan: Ultra High Speed 300 Mbps Unlimited\nMonthly Subscription: $49.99\nRouter Rental: $5.00\nTaxes (GST 18%): $9.90\nTotal Bill Amount: $64.89\nPayment Status: Paid via Auto-Debit"])
    manifest.append({"id": "bill_02", "file": p17, "expected": False, "category": "Non-Medical Utility Bill"})

    # 5.3 Payment / Grocery Receipt
    p18 = os.path.join(CORPUS_DIR, "18_receipt_grocery.png")
    create_synthetic_image(p18, ["SUPERMART EXPRESS RECEIPT", "Store #402 - Main Street", "Item 1: Organic Milk 1 Gal  $3.99", "Item 2: Whole Wheat Bread  $2.49", "Item 3: Dishwashing Detergent $4.29", "Subtotal: $10.77", "Tax: $0.86", "Total: $11.63", "Card Payment: Visa **** 1290", "Thank you for shopping!"])
    manifest.append({"id": "bill_03", "file": p18, "expected": False, "category": "Non-Medical Utility Bill"})

    # -------------------------------------------------------------
    # 6. Identity Cards (n=3) -> Expected: NON_MEDICAL
    # -------------------------------------------------------------
    # 6.1 Aadhaar Card
    p19 = os.path.join(CORPUS_DIR, "19_id_aadhaar.png")
    create_synthetic_image(p19, ["GOVERNMENT OF INDIA", "Unique Identification Authority of India", "Name: Rajesh Kumar", "DOB: 15/08/1985", "Gender: Male", "Aadhaar No: 3829 4819 0192", "Mera Aadhaar, Meri Pehchaan"])
    manifest.append({"id": "id_01", "file": p19, "expected": False, "category": "Identity Card"})

    # 6.2 PAN Card
    p20 = os.path.join(CORPUS_DIR, "20_id_pan.png")
    create_synthetic_image(p20, ["INCOME TAX DEPARTMENT", "GOVERNMENT OF INDIA", "Permanent Account Number Card", "Name: ANITA SHARMA", "Father's Name: SURESH SHARMA", "DOB: 22/11/1990", "PAN: ABCDE1234F"])
    manifest.append({"id": "id_02", "file": p20, "expected": False, "category": "Identity Card"})

    # 6.3 Voter ID
    p21 = os.path.join(CORPUS_DIR, "21_id_voter.png")
    create_synthetic_image(p21, ["ELECTION COMMISSION OF INDIA", "ELECTOR PHOTO IDENTITY CARD", "EPIC NO: WBL8291038", "Name: VIKRAM PATEL", "Father's Name: KISHORE PATEL", "Gender: MALE", "Age: 32 Years"])
    manifest.append({"id": "id_03", "file": p21, "expected": False, "category": "Identity Card"})

    # -------------------------------------------------------------
    # 7. Advertisements (n=3) -> Expected: NON_MEDICAL
    # -------------------------------------------------------------
    # 7.1 Digital PDF flyer with commercial marketing triggers
    p22 = os.path.join(CORPUS_DIR, "22_ad_digital_flyer.pdf")
    create_synthetic_pdf(p22, ["MEGA HEALTH RESORT & SPA FESTIVAL\nSpecial discount! Call toll free 1-800-555-SPA.\nLimited time offer: Flat 50% discount on all wellness memberships.\nVisit us at www.spa-resort-offers.com.\nContact sales today! Sponsored by Global Holiday Club."])
    manifest.append({"id": "ad_01", "file": p22, "expected": False, "category": "Advertisement"})

    # 7.2 Scanned raster JPEG pharma marketing flyer
    p23 = os.path.join(CORPUS_DIR, "23_ad_scanned_pharma.jpg")
    create_synthetic_image(p23, ["PHARMA BRAND MARKETING PROMOTION", "Introducing New Brand NutriBoost Gummies", "Retail Launch Offer: Buy 1 Get 1 Free", "For stockist and distribution inquiries call now: 1800-444-222", "Flat discount available on bulk distributor orders."])
    manifest.append({"id": "ad_02", "file": p23, "expected": False, "category": "Advertisement"})

    # 7.3 Hospital commercial promotional brochure
    p24 = os.path.join(CORPUS_DIR, "24_ad_hospital_promo.pdf")
    create_synthetic_pdf(p24, ["SUNSHINE LUXURY HOSPITAL SUITES\nBook your 5-star executive maternity luxury suite today!\nSpecial discount for early bird reservations.\nVisit us at www.sunshine-suites.com or call toll free 1800-888-999.\nComplimentary valet parking and gourmet dining included.\nContact sales team now."])
    manifest.append({"id": "ad_03", "file": p24, "expected": False, "category": "Advertisement"})

    # -------------------------------------------------------------
    # 8. Blank Documents (n=2) -> Expected: NON_MEDICAL
    # -------------------------------------------------------------
    # 8.1 Pure white digital image
    p25 = os.path.join(CORPUS_DIR, "25_blank_white.jpg")
    img_white = Image.new("RGB", (400, 400), color="white")
    img_white.save(p25)
    manifest.append({"id": "blank_01", "file": p25, "expected": False, "category": "Blank Document"})

    # 8.2 Scanner shadow/dust blank image
    p26 = os.path.join(CORPUS_DIR, "26_blank_dust.png")
    img_dust = Image.new("RGB", (400, 400), color=(252, 252, 252))
    img_dust.save(p26)
    manifest.append({"id": "blank_02", "file": p26, "expected": False, "category": "Blank Document"})

    # -------------------------------------------------------------
    # 9. Mixed PDFs (n=4) -> Expected: Rule-specific
    # -------------------------------------------------------------
    # 9.1 Lab Report + Ad page (Anchor rule -> True)
    p27 = os.path.join(CORPUS_DIR, "27_mixed_lab_plus_ad.pdf")
    create_synthetic_pdf(p27, [
        "METROPOLIS CLINICAL LABORATORY REPORT\nPatient: Anita Roy\nTest: Complete Blood Count\nHb: 12.8 g/dL\nWBC: 7,200\nPlatelets: 250,000\nDoctor: Dr. Sen MD",
        "SPONSORED PROMOTIONAL FLYER\nSpecial discount on next fitness tracker!\nCall toll free 1800-222-333\nLimited time offer\nVisit us at www.promotions-deal.com",
    ])
    manifest.append({"id": "mixed_01", "file": p27, "expected": True, "category": "Mixed PDF (Lab+Ad)"})

    # 9.2 Discharge summary + blank page (Anchor rule -> True)
    p28 = os.path.join(CORPUS_DIR, "28_mixed_discharge_plus_blank.pdf")
    doc28 = fitz.open()
    page1 = doc28.new_page(width=595, height=842)
    page1.insert_text((50, 80), "HOSPITAL DISCHARGE SUMMARY\nPatient: Vikram Singh\nDiagnosis: Viral Gastroenteritis\nDischarge Medications: Tab Cifran 500mg, Cap Omez 20mg\nCondition at discharge: Stable and afebrile.", fontsize=12)
    page2 = doc28.new_page(width=595, height=842)  # Completely blank page
    doc28.save(p28)
    doc28.close()
    manifest.append({"id": "mixed_02", "file": p28, "expected": True, "category": "Mixed PDF (Discharge+Blank)"})

    # 9.3 Prescription + insurance disclaimer (Anchor rule -> True)
    p29 = os.path.join(CORPUS_DIR, "29_mixed_rx_plus_disclaimer.pdf")
    create_synthetic_pdf(p29, [
        "FAMILY HEALTH CLINIC\nDr. M. K. Gupta MBBS MD\nRx:\nTab Paracetamol 650mg TDS x 3d\nTab Cetirizine 10mg HS x 5d\nSignature: Dr. Gupta",
        "GENERAL TERMS AND CONDITIONS / INSURANCE DISCLAIMER\nAll claims subject to policy terms and exclusions.\nThis document does not constitute guaranteed pre-authorization.",
    ])
    manifest.append({"id": "mixed_03", "file": p29, "expected": True, "category": "Mixed PDF (Rx+Disclaimer)"})

    # 9.4 Tax packet with 1 incidental pharmacy bill (Rule 3 Gated Dilution -> False)
    p30 = os.path.join(CORPUS_DIR, "30_mixed_tax_plus_receipt.pdf")
    create_synthetic_pdf(p30, [
        "INTERNAL REVENUE SERVICE FORM 1040\nU.S. Individual Income Tax Return\nTax Year 2025\nFiling Status: Single\nTotal Wages: $62,400\nAdjusted Gross Income: $62,400\nStandard Deduction: $14,600",
        "SCHEDULE A - ITEMIZED DEDUCTIONS\nState and Local Taxes: $4,500\nMortgage Interest: $8,200\nTotal Deductions: $12,700",
        "FORM W-2 WAGE AND TAX STATEMENT\nEmployer: Global Logistics Inc.\nFederal Income Tax Withheld: $7,200\nSocial Security Tax: $3,868",
        "INCIDENTAL PHARMACY STORE CASH RECEIPT\nStore: Corner Chemist\nBand-Aid 1 Pack: $2.50\nCough Drops: $1.80\nTotal Paid: $4.30",
    ])
    manifest.append({"id": "mixed_04", "file": p30, "expected": False, "category": "Mixed PDF (Tax+Incidental Receipt)"})

    return manifest


async def run_evaluation(manifest: list[dict[str, Any]]) -> None:
    settings = Settings(
        classifier_model_path="models/med-doc-classifier",
        ai_model="llama3",
        ai_base_url="http://localhost:11434",
    )
    storage = None
    service = MedicalValidationService(settings=settings, storage=storage)

    print("=" * 70)
    print("PHASE 17-02: MEDICAL DOCUMENT VALIDATION EVALUATION GATE (N = 30)")
    print("=" * 70)

    tp = 0  # Expected True, Got True
    fp = 0  # Expected False, Got True
    tn = 0  # Expected False, Got False
    fn = 0  # Expected True, Got False

    blank_total = 0
    blank_rejected = 0

    latencies: list[float] = []
    results_table: list[dict[str, Any]] = []

    for idx, item in enumerate(manifest, 1):
        fpath = item["file"]
        expected = item["expected"]
        cat = item["category"]

        with open(fpath, "rb") as f:
            file_bytes = f.read()

        t0 = time.perf_counter()
        resp = await service.validate_medical_document(
            file_bytes=file_bytes,
            file_name=os.path.basename(fpath),
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        latencies.append(elapsed_ms)

        actual = resp.isMedical
        conf = resp.confidence
        reason = resp.reason

        if cat == "Blank Document":
            blank_total += 1
            if not actual:
                blank_rejected += 1

        if expected and actual:
            tp += 1
            status_str = "CORRECT (TP)"
        elif not expected and not actual:
            tn += 1
            status_str = "CORRECT (TN)"
        elif not expected and actual:
            fp += 1
            status_str = "FALSE POSITIVE (FP)"
        else:
            fn += 1
            status_str = "FALSE NEGATIVE (FN)"

        print(
            f"[{idx:02d}/30] {os.path.basename(fpath):<32} | Expected: {str(expected):<5} | "
            f"Actual: {str(actual):<5} | Conf: {conf:.4f} | {elapsed_ms:6.1f}ms | {status_str}",
            flush=True,
        )

        results_table.append({
            "id": item["id"],
            "filename": os.path.basename(fpath),
            "category": cat,
            "expected": expected,
            "actual": actual,
            "confidence": conf,
            "reason": reason,
            "latency_ms": elapsed_ms,
        })

    total = len(manifest)
    total_medical = tp + fn
    total_non_medical = tn + fp

    sensitivity = (tp / total_medical) if total_medical > 0 else 0.0
    specificity = (tn / total_non_medical) if total_non_medical > 0 else 0.0
    accuracy = (tp + tn) / total
    blank_rate = (blank_rejected / blank_total) if blank_total > 0 else 1.0

    p50_lat = float(np.percentile(latencies, 50))
    p95_lat = float(np.percentile(latencies, 95))
    mean_lat = float(np.mean(latencies))

    print("\n" + "=" * 70)
    print("EVALUATION CONFUSION MATRIX & METRICS REPORT")
    print("=" * 70)
    print(f"Total Evaluated Documents (N): {total}")
    print(f"  - Actual Medical Ground Truth:     {total_medical}")
    print(f"  - Actual Non-Medical Ground Truth: {total_non_medical}")
    print()
    print("CONFUSION MATRIX:")
    print(f"  True Positives  (TP): {tp:<3} (Genuine medical accepted)")
    print(f"  True Negatives  (TN): {tn:<3} (Non-medical/bills/ads/IDs rejected)")
    print(f"  False Positives (FP): {fp:<3} (Non-medical accepted)")
    print(f"  False Negatives (FN): {fn:<3} (Genuine medical rejected)")
    print()
    print("ACCEPTANCE CRITERIA VERIFICATION:")
    print(f"  1. Clinical Sensitivity (Target >= 96%):  {sensitivity * 100:.2f}% ({tp}/{total_medical})")
    print(f"     -> Zero false rejections:              {'PASSED (0 FN)' if fn == 0 else f'FAILED ({fn} FN)'}")
    print(f"  2. Control Specificity (Target >= 93%):   {specificity * 100:.2f}% ({tn}/{total_non_medical})")
    print(f"     -> Target >= 93%:                      {'PASSED' if specificity >= 0.93 else 'FAILED'}")
    print(f"  3. Blank/Corrupt Rejection (Target 100%): {blank_rate * 100:.2f}% ({blank_rejected}/{blank_total})")
    print(f"     -> Target 100%:                        {'PASSED' if blank_rate == 1.0 else 'FAILED'}")
    print(f"  4. Overall Accuracy:                      {accuracy * 100:.2f}% ({tp + tn}/{total})")
    print()
    print("MEASURED LATENCY SUMMARY (CPU, 2 threads):")
    print(f"  Mean: {mean_lat:.1f}ms")
    print(f"  p50:  {p50_lat:.1f}ms")
    print(f"  p95:  {p95_lat:.1f}ms")
    print(f"  Min:  {min(latencies):.1f}ms")
    print(f"  Max:  {max(latencies):.1f}ms")
    print("=" * 70)


if __name__ == "__main__":
    items = populate_corpus()
    asyncio.run(run_evaluation(items))
