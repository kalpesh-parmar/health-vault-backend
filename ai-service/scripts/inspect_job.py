import asyncio
import json
import asyncpg

async def main():
    conn = await asyncpg.connect("postgresql://postgres:123@localhost:5432/health-vault-v4")
    row = await conn.fetchrow(
        "SELECT id, status, stage, stage_status, attempt_count, percentage, error, message, checkpoint_data, raw_ocr_data "
        "FROM document_processing_jobs WHERE id = '6e6235c0-c22b-4979-b120-78c0060e6440'"
    )
    if not row:
        print("JOB NOT FOUND")
        await conn.close()
        return

    print("STATUS:", row["status"])
    print("STAGE:", row["stage"])
    print("STAGE_STATUS:", row["stage_status"])
    print("ATTEMPT_COUNT:", row["attempt_count"])
    print("ERROR:", row["error"])
    print("MESSAGE:", row["message"])
    raw_ocr = row["raw_ocr_data"]
    if raw_ocr:
        if isinstance(raw_ocr, str):
            raw_ocr = json.loads(raw_ocr)
        print("RAW_OCR_DATA keys:", list(raw_ocr.keys()) if isinstance(raw_ocr, dict) else type(raw_ocr))
        if isinstance(raw_ocr, dict):
            print("fullText:", repr(raw_ocr.get("fullText", ""))[:300])
            print("pages count:", len(raw_ocr.get("pages", [])))
            for p in raw_ocr.get("pages", []):
                print(f"  Page {p.get('page')}: engine={p.get('engine')}, status={p.get('status')}, fallback_reason={p.get('fallback_reason')}, error={p.get('error')}")
                print(f"    text snippet: {repr(p.get('text', ''))[:200]}")
    ckpt = row["checkpoint_data"]
    if ckpt:
        if isinstance(ckpt, str):
            ckpt = json.loads(ckpt)
        print("CHECKPOINT_DATA keys:", list(ckpt.keys()) if isinstance(ckpt, dict) else type(ckpt))
        if isinstance(ckpt, dict) and "OCR_RUNNING" in ckpt:
            ocr_ckpt = ckpt["OCR_RUNNING"]
            print("OCR_RUNNING checkpoint:", ocr_ckpt)

    await conn.close()

if __name__ == "__main__":
    asyncio.run(main())
