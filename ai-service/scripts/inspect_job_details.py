import asyncio
import json
import asyncpg

async def main():
    conn = await asyncpg.connect("postgresql://postgres:123@localhost:5432/health-vault-v4")
    row = await conn.fetchrow(
        "SELECT checkpoint_data FROM document_processing_jobs WHERE id = '6e6235c0-c22b-4979-b120-78c0060e6440'"
    )
    ckpt = row["checkpoint_data"]
    if isinstance(ckpt, str):
        ckpt = json.loads(ckpt)
    print("STAGE_DETAILS:", json.dumps(ckpt.get("stage_details"), indent=2))
    print("ERROR_CODE:", ckpt.get("error_code"))
    print("S3_KEY:", ckpt.get("s3Key"))
    print("VALIDATING:", json.dumps(ckpt.get("VALIDATING"), indent=2))
    print("UPLOADING:", json.dumps(ckpt.get("UPLOADING"), indent=2))
    await conn.close()

if __name__ == "__main__":
    asyncio.run(main())
