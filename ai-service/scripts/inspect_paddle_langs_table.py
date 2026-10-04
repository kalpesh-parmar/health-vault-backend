import paddleocr.paddleocr as p

print("SUPPORT_OCR_MODEL_VERSION:", p.SUPPORT_OCR_MODEL_VERSION)
print("SUPPORT_CHARACTER_TYPE:", getattr(p, "SUPPORT_CHARACTER_TYPE", None))
for k in dir(p):
    if "MODEL" in k or "LANG" in k or "SUPPORT" in k:
        val = getattr(p, k)
        if isinstance(val, (dict, list, set, tuple)):
            print(f"{k} ({type(val).__name__}): {val}")
