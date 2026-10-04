import paddleocr
from paddleocr.tools.infer import utility

print("PaddleOCR version:", paddleocr.__version__)
args = utility.init_args()
print("Language choices:", args.format_help() if hasattr(args, "format_help") else "No help")
