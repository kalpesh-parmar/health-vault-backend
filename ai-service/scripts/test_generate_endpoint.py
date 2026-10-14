import asyncio
import base64
import time
from pathlib import Path
import httpx

async def main():
    base_url = "http://192.168.21.176:11434"
    model = "qwen3-vl:latest"
    img_path = Path(r"D:\TECHROVER\PROJECTS\RTH\healh-vault-project\Medical Reports\lab_1_.jpeg")
    img_bytes = img_path.read_bytes()
    b64_img = base64.b64encode(img_bytes).decode("ascii")

    strict_prompt = (
        "Transcribe the exact text from this image line by line verbatim. "
        "Output raw text only. Do not translate. Do not summarize. "
        "Do not add markdown headers. Do not explain."
    )

    payload = {
        "model": model,
        "prompt": strict_prompt,
        "images": [b64_img],
        "stream": False,
        "options": {
            "temperature": 0.0,
            "num_predict": 1536,
        }
    }

    print("\n--- Testing /api/generate with strict_prompt ---")
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(f"{base_url}/api/generate", json=payload)
    elapsed = time.monotonic() - t0

    data = resp.json()
    response_text = data.get("response", "")
    done_reason = data.get("done_reason")
    eval_count = data.get("eval_count")

    print(f"Elapsed: {elapsed:.2f}s, done_reason: {done_reason}, eval_count: {eval_count}")
    print(f"Response length: {len(response_text)} chars")
    print(f"Response preview:\n{response_text}")

if __name__ == "__main__":
    asyncio.run(main())
