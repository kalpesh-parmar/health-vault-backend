from fastapi import FastAPI, UploadFile, File
import shutil
import os
from src.pythonService.ocr_service import extract_text
from src.pythonService.parser import parse_medical_data
from src.pythonService.text_utils import clean_text

app = FastAPI()

@app.post("/run-ocr")
async def run_ocr(file: UploadFile = File(...)):
    try:
        #  Save file temporarily
        temp_path = f"temp_{file.filename}"

        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        #  Send file path to OCR
        ocr_result = extract_text(temp_path)
        #convert list to string 
        text = " ".join(ocr_result) if isinstance(ocr_result, list) else ocr_result
        #clean text
        cleaned_text = clean_text(text)
        #parse structure data
        structured_data = parse_medical_data(cleaned_text)

        #  Delete temp file
        os.remove(temp_path)

        return {
    "success": True,
    "data": structured_data
    }
    except Exception as e:
        import traceback
        return {
            "success": False,
            "error": str(e),
            "trace": traceback.format_exc()
        }