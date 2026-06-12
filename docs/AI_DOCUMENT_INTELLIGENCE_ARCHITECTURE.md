# AI Document Intelligence Architecture

## Pipeline

Upload PDF -> object storage -> Node job state -> FastAPI extraction -> PyMuPDF selectable text -> Qwen2.5-VL fallback for scanned PDFs -> structured medical JSON -> summary -> pgvector chunks and embeddings -> document chat and graph extraction.

## Runtime Components

- Node API keeps the existing document, chat, and SSE response contracts.
- FastAPI AI service owns PDF text extraction, Qwen2.5-VL scanned-page extraction, summaries, embeddings, chat, and graph normalization.
- PostgreSQL is accessed with `pg`; pgvector stores embeddings for RAG.
- Object storage can be GCP, S3, or local depending on `STORAGE_PROVIDER`.
- Qwen2.5-VL is a singleton FastAPI service client backed by Ollama and reused across requests.

## Structured Medical JSON

```json
{
  "patientInfo": {},
  "hospitalInfo": {},
  "doctorInfo": {},
  "diagnosis": [],
  "medications": [],
  "labResults": [],
  "vitals": [],
  "recommendations": [],
  "summary": ""
}
```

Legacy fields such as `doctorName`, `hospitalName`, `patientName`, `testResults`, `observations`, and `reportDate` are still included where possible so current frontend screens continue to work.

## RAG Chat Flow

1. Embed the user question with the FastAPI embedding endpoint.
2. Search the authenticated user's pgvector chunks.
3. Send only retrieved chunks and recent session history to the chat endpoint.
4. Persist chat messages and citations.
5. Return the existing reply/citation contract.

## Operational Notes

- Only PDF upload is accepted by the document intelligence flow.
- Selectable PDFs never call the vision model.
- Scanned PDFs are rendered in memory and sent to Qwen2.5-VL without temporary page files or image preprocessing.
- Embeddings are generated after the frontend confirms the extracted payload, so user edits are reflected in RAG.
