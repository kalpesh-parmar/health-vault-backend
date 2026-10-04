import time
from paddleocr import PaddleOCR
import numpy as np

print("Initializing PaddleOCR with lang='devanagari' on CPU...")
t0 = time.perf_counter()
try:
    ocr_deva = PaddleOCR(lang="devanagari", use_gpu=False, show_log=False)
    elapsed = time.perf_counter() - t0
    print(f"Success! Initialized in {elapsed:.2f}s")
    
    # Test on dummy image
    dummy = np.zeros((64, 256, 3), dtype=np.uint8)
    res = ocr_deva.ocr(dummy, cls=False)
    print("OCR inference on dummy image succeeded:", res)
except Exception as e:
    print("Error initializing devanagari PaddleOCR:", e)
    import traceback
    traceback.print_exc()
