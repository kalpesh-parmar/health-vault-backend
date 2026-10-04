import asyncio
import sys
from pathlib import Path

# Add ai-service to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.settings import Settings
from app.container import Container
from app.modules.vision.vision_service import _page_prompt
import fitz

async def test():
    settings = Settings()
    container = Container(settings)
    await container.start()
    service = container.vision
    doc = fitz.open(r"D:\TECHROVER\PROJECTS\RTH\healh-vault-project\Medical Reports\Masa's Report\Manjuben Ranoliya.pdf")
    page = doc.load_page(0)
    pix = page.get_pixmap(dpi=150)
    img_bytes = pix.tobytes("png")
    print(f"Rendered image bytes: {len(img_bytes)}", flush=True)
    
    raw, finish_reason = await service._generate(img_bytes, mime_type="image/png", prompt=_page_prompt(1))
    print(f"Finish reason: {finish_reason}", flush=True)
    print(f"Raw response length: {len(raw)}", flush=True)
    print("=== RAW RESPONSE PREVIEW (first 500 chars) ===", flush=True)
    print(raw[:500], flush=True)
    print("=== RAW RESPONSE PREVIEW (last 500 chars) ===", flush=True)
    print(raw[-500:] if len(raw) > 500 else raw, flush=True)
    await container.stop()

if __name__ == "__main__":
    asyncio.run(test())
