"""Generate anonymized 4-page hybrid PDF fixture matching production problem:
Page 1: Born-digital CBC Lab Report (Direct text, valid)
Page 2: Born-digital Metabolic Panel (Direct text, valid)
Page 3: Scanned Hindi Lab Report (Raster OCR)
Page 4: Scanned Gujarati Lab Report (Raster OCR)
"""

import sys
from pathlib import Path
AI_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AI_DIR))

import fitz
from app.modules.file_processing.pdf_text import validate_page_direct_text

p1_text = """METRO HEALTHCARE CLINICAL LABORATORY
Patient Name: Anonymous Patient    Age: 45    Sex: Male    Date: 2026-03-15
Doctor: Dr. Sarah Jenkins    Ref ID: MH-2026-9921
COMPLETE BLOOD COUNT REPORT
Test Name                 Result      Unit       Reference Range    Status
Hemoglobin                14.2        g/dL       13.0 - 17.0        NORMAL
Total Leucocyte Count     7500        cells      4000 - 11000       NORMAL
Red Blood Cell Count      4.8         million    4.5 - 5.5          NORMAL
Platelet Count            250000      cells      150000 - 450000    NORMAL
Packed Cell Volume        42.5        %          40.0 - 50.0        NORMAL
Mean Corpuscular Volume   88.5        fL         80.0 - 100.0       NORMAL
Impression: Complete blood count parameters are within normal physiological range.
Dr. Sarah Jenkins, MD Pathologist
Page 1 of 2
"""

p2_text = """METRO HEALTHCARE CLINICAL LABORATORY
Patient Name: Anonymous Patient    Age: 45    Sex: Male    Date: 2026-03-15
Doctor: Dr. Sarah Jenkins    Ref ID: MH-2026-9921
COMPREHENSIVE METABOLIC PANEL
Test Name                 Result      Unit       Reference Range    Status
Fasting Blood Glucose     95          mg/dL      70 - 99            NORMAL
Glycated Hemoglobin       5.4         %          4.0 - 5.6          NORMAL
Blood Urea Nitrogen       14          mg/dL      7 - 20             NORMAL
Serum Creatinine          0.9         mg/dL      0.6 - 1.2          NORMAL
Total Bilirubin           0.8         mg/dL      0.2 - 1.2          NORMAL
Serum Potassium           4.2         mmol/L     3.5 - 5.0          NORMAL
Impression: Metabolic profile is within normal clinical limits.
Dr. Sarah Jenkins, MD Pathologist
Page 2 of 2
"""

doc = fitz.open()

p1 = doc.new_page(width=595, height=842)
p1.insert_text((50, 72), p1_text, fontsize=11)

p2 = doc.new_page(width=595, height=842)
p2.insert_text((50, 72), p2_text, fontsize=11)

p3_img = AI_DIR / "tests" / "fixtures" / "golden_scanned" / "hi" / "hi_03_lab_report.png"
p3 = doc.new_page(width=595, height=842)
p3.insert_image(fitz.Rect(0, 0, 595, 842), filename=str(p3_img))

p4_img = AI_DIR / "tests" / "fixtures" / "golden_scanned" / "gu" / "gu_04_lab_report.png"
p4 = doc.new_page(width=595, height=842)
p4.insert_image(fitz.Rect(0, 0, 595, 842), filename=str(p4_img))

out_path = AI_DIR / "tests" / "fixtures" / "anonymized" / "anonymized_4page_hybrid.pdf"
out_path.parent.mkdir(parents=True, exist_ok=True)
doc.save(str(out_path))
doc.close()

verify_doc = fitz.open(str(out_path))
print("Generated anonymized 4-page hybrid PDF:", out_path)
for i in range(len(verify_doc)):
    txt = verify_doc[i].get_text()
    v = validate_page_direct_text(verify_doc, i + 1, txt)
    print(f"Page {i + 1}: valid_direct={v.is_valid_direct_text}, reason={v.rejection_reason}, chars={len(txt.strip())}")
verify_doc.close()
