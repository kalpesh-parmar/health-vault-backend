from paddleocr import PaddleOCR

ocr = PaddleOCR( use_angle_cls=True, lang='en')

def extract_text(file_path):
    result = ocr.ocr(file_path, cls=True)

    lines = []
    for line in result[0]:
        lines.append(line[1][0])

    return lines