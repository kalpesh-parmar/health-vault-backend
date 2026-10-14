import asyncio
import base64
from pathlib import Path
import httpx

async def test_case(name: str, payload_modifier: dict):
    base_url = "http://192.168.21.176:11434"
    model = "qwen3-vl:latest"
    img_path = Path(r"D:\TECHROVER\PROJECTS\RTH\healh-vault-project\Medical Reports\lab_1_.jpeg")
    b64_img = base64.b64encode(img_path.read_bytes()).decode("ascii")

    base_payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": "Transcribe ALL text in this image line by line verbatim. Output raw text only. No explanation.",
                "images": [b64_img],
            }
        ],
        "stream": False,
        "options": {
            "temperature": 0.0,
            "num_predict": 1024,
        }
    }
    # Deep merge / update
    for k, v in payload_modifier.items():
        if isinstance(v, dict) and k in base_payload:
            base_payload[k].update(v)
        else:
            base_payload[k] = v

    print(f"\n=== Case: {name} ===")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{base_url}/api/chat", json=base_payload)
    data = resp.json()
    msg = data.get("message", {})
    content = msg.get("content", "")
    reasoning = msg.get("reasoning_content") or msg.get("thinking") or ""
    done_reason = data.get("done_reason")
    eval_count = data.get("eval_count")
    print(f"done_reason={done_reason}, eval_count={eval_count}")
    print(f"content({len(content)} chars): {repr(content[:150])}")
    print(f"reasoning({len(reasoning)} chars): {repr(reasoning[:150])}")

async def main():
    # Case 1: System prompt suppressing reasoning
    await test_case("System prompt no-think", {
        "messages": [
            {"role": "system", "content": "You are a OCR text extraction tool. Return only the extracted text without any reasoning, thinking, or introduction."},
            {"role": "user", "content": "Transcribe all text from this image exactly as written.", "images": [base64.b64encode(Path(r"D:\TECHROVER\PROJECTS\RTH\healh-vault-project\Medical Reports\lab_1_.jpeg").read_bytes()).decode("ascii")]}
        ]
    })

    # Case 2: think: false in options and payload
    await test_case("think: false in options", {
        "think": False,
        "options": {"temperature": 0.0, "num_predict": 1024, "think": False}
    })

if __name__ == "__main__":
    asyncio.run(main())
