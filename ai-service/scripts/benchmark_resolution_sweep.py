import asyncio
import io
import json
import sys
import time
from pathlib import Path
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path("d:/TECHROVER/health-vault/health-vault-backend/ai-service").resolve()
sys.path.insert(0, str(BASE_DIR))

from app.settings import Settings
from app.container import Container
from app.modules.vision.vision_service import downscale_image_if_needed, build_ocr_prompt

async def run_sweep():
    settings = Settings()
    container = Container(settings=settings)
    await container.start()

    img_path = BASE_DIR / "tests/fixtures/golden_scanned/gu/gu_02_prescription.png"
    orig_bytes = img_path.read_bytes()
    orig_img = Image.open(io.BytesIO(orig_bytes))
    orig_w, orig_h = orig_img.size

    resolutions = [1500, 1800, 2000, max(orig_w, orig_h)]
    prompt = build_ocr_prompt("gujarati")

    results = []

    print(f"=== BENCHMARK RESOLUTION SWEEP ON {img_path.name} ({orig_w}x{orig_h}) ===")

    for max_s in resolutions:
        # Prepare downscaled image
        scaled_bytes, info = downscale_image_if_needed(orig_bytes, max_side=max_s)
        scaled_img = Image.open(io.BytesIO(scaled_bytes))
        sw, sh = scaled_img.size

        # Measure 2 runs for stability
        latencies = []
        texts = []
        for run_idx in range(2):
            t0 = time.time()
            res = await container.vision.extract_image(
                scaled_bytes,
                prompt=prompt,
                filename=f"gu_02_{sw}x{sh}.png",
                mime_type="image/png",
                script_hint="gujarati",
            )
            lat = time.time() - t0
            latencies.append(lat)
            texts.append(res.get("text", ""))

        avg_lat = sum(latencies) / len(latencies)
        final_text = texts[-1]

        # Evaluate fields
        has_sterling = "સ્ટર્લિંગ" in final_text
        has_ramanbhai = "રમણભાઈ" in final_text or "રમાભાઈ" in final_text or "રમણ" in final_text
        has_56 = "૫૬" in final_text or "56" in final_text
        has_45 = "45" in final_text or "૪૫" in final_text

        meds_found = sum(
            1 for m in ["Glimisave", "Telma", "Rosuvas", "Becosules"]
            if m.lower() in final_text.lower()
        )

        res_summary = {
            "max_side": max_s,
            "dimensions": f"{sw}x{sh}",
            "bytes": len(scaled_bytes),
            "avg_latency_s": round(avg_lat, 2),
            "latencies": [round(l, 2) for l in latencies],
            "has_sterling_clinic": has_sterling,
            "has_ramanbhai_name": has_ramanbhai,
            "has_age_56": has_56,
            "has_age_45": has_45,
            "meds_count": meds_found,
            "sample_text": final_text[:350],
        }
        results.append(res_summary)
        print(f"\n--- Max Side: {max_s} ({sw}x{sh}) | Latency: {avg_lat:.2f}s | Bytes: {len(scaled_bytes)} ---")
        print(f"Clinic (સ્ટર્લિંગ): {has_sterling} | Name (રમણભાઈ): {has_ramanbhai} | Age 56: {has_56} (Age 45: {has_45}) | Meds: {meds_found}/4")
        print("Sample Text:\n", final_text[:250])

    out_file = BASE_DIR / "scripts" / "benchmark_results" / "resolution_sweep.json"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved results to {out_file}")

if __name__ == "__main__":
    asyncio.run(run_sweep())
