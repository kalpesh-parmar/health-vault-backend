import asyncio
import base64
import json
import time
from pathlib import Path
import httpx

async def test_ollama(num_predict: int, prompt_suffix: str = ""):
    base_url = "http://192.168.21.176:11434"
    model = "qwen3-vl:latest"
    img_path = Path(r"D:\TECHROVER\PROJECTS\RTH\healh-vault-project\Medical Reports\lab_1_.jpeg")
    img_bytes = img_path.read_bytes()
    b64_img = base64.b64encode(img_bytes).decode("ascii")

    prompt = (
        "You are an accurate OCR engine for medical documents. "
        "Transcribe ALL visible text exactly as it appears in this document image into clean markdown/plain text. "
        "Preserve line breaks, exact numbers, test names, values, units, reference intervals, dates, and tabular column alignments. "
        "Do not summarize, interpret, translate, or omit any text. "
        "Output ONLY the transcribed document text."
    )
    if prompt_suffix:
        prompt += f"\n\n{prompt_suffix}"

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [b64_img],
            }
        ],
        "stream": False,
        "keep_alive": "10m",
        "options": {
            "temperature": 0.0,
            "num_predict": num_predict,
            "num_ctx": 8192,
        },
    }

    print(f"\n--- Testing num_predict={num_predict}, suffix={bool(prompt_suffix)} ---")
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(f"{base_url}/api/chat", json=payload)
    elapsed = time.monotonic() - t0

    data = resp.json()
    msg = data.get("message", {})
    content = msg.get("content", "")
    reasoning = msg.get("reasoning_content") or msg.get("thinking") or ""
    done_reason = data.get("done_reason")
    eval_count = data.get("eval_count")

    print(f"Elapsed: {elapsed:.2f}s, done_reason: {done_reason}, eval_count: {eval_count}")
    print(f"Reasoning length: {len(reasoning)} chars")
    print(f"Content length: {len(content)} chars")
    print(f"Content preview:\n{content[:400]}")

async def main():
    await test_ollama(4096)

if __name__ == "__main__":
    asyncio.run(main())
