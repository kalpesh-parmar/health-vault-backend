from fastapi import FastAPI
from pydantic import BaseModel
from pathlib import Path
from dotenv import load_dotenv
import boto3
import os
from src.pythonService.ocr_service import extract_text
from src.pythonService.text_utils import clean_text
from src.pythonService.graphParser import extract_graph_data
# import google.generativeai as genai

# genai.configure(
#     api_key=os.getenv("CHATBOT_API_KEY")
# )
# model = genai.GenerativeModel(
#     "gemini-2.5-flash"
# )

app = FastAPI()
env_path = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(dotenv_path=env_path)
s3 = boto3.client("s3")


class OCRRequest(BaseModel):
    fileKey: str
    bucket: str


@app.post("/run-ocr")
async def run_ocr(payload: OCRRequest):

    try:
        file_key = payload.fileKey
        bucket = payload.bucket

        # local temp file
        temp_path = f"temp_{os.path.basename(file_key)}"

        # download from s3
        s3.download_file(
            bucket,
            file_key,
            temp_path
        )

        # OCR
        ocr_result = extract_text(temp_path)
        text = (
            " ".join(ocr_result)
            if isinstance(ocr_result, list)
            else ocr_result
        )

        cleaned_text = clean_text(text)
        graph_data = extract_graph_data(temp_path)
        # structured_data = parse_medical_data(cleaned_text)

        # delete temp file
        os.remove(temp_path)

        return {
            "success": True,    
            "ocr_text": cleaned_text,
            "graphs":graph_data
        }

    except Exception as e:
        import traceback

        return {
            "success": False,
            "error": str(e),
            "trace": traceback.format_exc()
        }