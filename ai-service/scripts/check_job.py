import asyncpg
import asyncio
import json

async def run():
    conn = await asyncpg.connect('postgres://postgres:123@localhost:5432/health-vault-v4')
    rows = await conn.fetch('''
        SELECT id, file_key, status, stage, stage_status, percentage, updated_at, 
               raw_ocr_data IS NOT NULL as has_ocr, 
               checkpoint_data
        FROM document_processing_jobs 
        ORDER BY created_at DESC 
        LIMIT 4
    ''')
    for jid in ['ecb36373-839a-4ad1-b4b9-ea2adc7556b9', '91a42fcc-55a1-45f9-9641-ff53bb466fe3']:
        r = await conn.fetchrow('''
            SELECT id, file_key, status, stage, stage_status, percentage, current_step, created_at, updated_at, last_heartbeat_at,
                   raw_ocr_data IS NOT NULL as has_ocr, metadata, checkpoint_data, completed_stages
            FROM document_processing_jobs 
            WHERE id = $1
        ''', jid)
        if not r:
            continue
        print("---")
        print(f"ID: {r['id']}")
        print(f"File: {r['file_key']}")
        print(f"Status: {r['status']} | Stage: {r['stage']} ({r['stage_status']}) | {r['percentage']}% | Step: {r['current_step']}")
        print(f"Created: {r['created_at']} | Updated: {r['updated_at']} | Heartbeat: {r['last_heartbeat_at']}")
        print(f"Completed stages: {r['completed_stages']}")
        print(f"Metadata: {r['metadata']}")
        print(f"Checkpoint: {r['checkpoint_data']}")
        r_ocr = await conn.fetchrow('SELECT raw_ocr_data FROM document_processing_jobs WHERE id = $1', jid)
        if r_ocr and r_ocr['raw_ocr_data']:
            data = r_ocr['raw_ocr_data']
            if isinstance(data, str):
                data = json.loads(data)
            pages = data.get('pages', []) if data else []
            print(f"Pages in OCR: {len(pages)}")
            for p in pages:
                print(f"  Page {p.get('page')}: len={len(p.get('text', ''))} chars, elapsed={p.get('elapsed_ms')}ms")
                if p.get('text'):
                    preview = p['text'][:120].replace('\n', ' ')
                    print(f"    Preview: {preview}")
    await conn.close()

if __name__ == '__main__':
    asyncio.run(run())
