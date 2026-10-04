import inspect
from paddleocr import paddleocr

source = inspect.getsource(paddleocr.PaddleOCR.__init__)
print("Full PaddleOCR.__init__ lines mentioning lang:")
for idx, line in enumerate(source.splitlines()):
    if "lang" in line.lower() or "support" in line.lower():
        print(f"{idx}: {line}")
