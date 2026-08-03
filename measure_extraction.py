import asyncio
import importlib.util
import logging
import sys
import types
import time
from pathlib import Path

repo = r'F:\Health-vault-backend\health-vault-backend\ai-service'
sys.path.insert(0, repo)

# Stub optional heavy dependencies so the timing path can run in this environment.
paddle_stub = types.ModuleType('paddle')
paddle_stub.get_device = lambda: 'cpu'
sys.modules['paddle'] = paddle_stub

cv2_stub = types.ModuleType('cv2')
cv2_stub.IMREAD_COLOR = 1
cv2_stub.imdecode = lambda data, flags: object()
sys.modules['cv2'] = cv2_stub

numpy_stub = types.ModuleType('numpy')
class _ArrayLike: pass
numpy_stub.uint8 = 0
numpy_stub.frombuffer = lambda data, dtype: _ArrayLike()
sys.modules['numpy'] = numpy_stub

from app.modules.vision import vision_service
from app.modules.ocr.service import OcrService

class CaptureHandler(logging.Handler):
    def emit(self, record):
        extras = {k: v for k, v in record.__dict__.items() if k not in {'args','msg','message','levelname','levelno','name','pathname','filename','module','exc_info','exc_text','stack_info','lineno','funcName','created','msecs','relativeCreated','thread','threadName','processName','process','taskName','task','msg'}}
        print(f"{record.levelname} {record.getMessage()} {extras}")

logging.getLogger().handlers = [CaptureHandler()]
logging.getLogger().setLevel(logging.INFO)

class FakeOcr:
    def ocr(self, img):
        time.sleep(0.18)
        return [[['Sample OCR text', [0.95]]]]

vision_service.global_ocr = FakeOcr()

class StubVision:
    async def extract_image(self, data, *, filename, mime_type, max_pages):
        svc = vision_service.VisionModelService(
            api_key='',
            base_url='http://localhost',
            model='dummy',
            timeout_seconds=30,
            max_retries=1,
            max_output_tokens=256,
            min_text_chars=1,
            cache_size=0,
            max_inline_bytes=10 * 1024 * 1024,
        )
        return await svc._generate(data, mime_type=mime_type)

async def main():
    service = OcrService(StubVision(), max_pdf_pages=1, fail_on_empty=True)
    payload = b'not-a-real-image'
    started = time.monotonic()
    result = await service.extract_document_bytes(document_bytes=payload, filename='sample.png', mime_type='image/png')
    elapsed_ms = int((time.monotonic() - started) * 1000)
    print(f'TOTAL_EXTRACTION_MS={elapsed_ms}')
    print(f'RESULT_TEXT_LEN={len(result.get("text", ""))}')

asyncio.run(main())
