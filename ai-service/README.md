# Health Vault Unified AI Service

The **Health Vault Unified AI Service** is a self-contained, high-performance, and modular Python backend built with FastAPI. It handles complex AI workloads including medical document OCR and text routing, Patient summaries, Retrieval-Augmented Generation (RAG) chat, semantic vector search, and voice/speech transcription and synthesis.

Designed to run independently or as part of the Health Vault monorepo, it features lazy model loading (avoiding startup crashes on Windows), robust WebSocket handlers, and a centralized JSON parsing utility for LLM block extraction.

---

## 🚀 Key Features

- **Fast Direct-Text Routing**: Automatically detects native/born-digital PDFs and extracts their text using PyMuPDF (rendering latency < 100ms), bypassing slow and expensive vision models.
- **Vision-Based OCR & Fallback**: Renders scanned PDFs or images and extracts structured data using vision LLMs (e.g., Qwen-VL, Gemini), fallback-parsing summaries to prevent slow roundtrips.
- **Vector Search & RAG Chat**: Integrates with PostgreSQL (`pgvector`) using SentenceTransformers (`all-MiniLM-L6-v2`) to perform semantic retrieval and contextual Q&A.
- **Real-time Voice websocket**: Features WebSocket-based speech-to-text (Whisper) and text-to-speech (TTS) pipelines with clean session buffers.
- **Production Readiness**: Includes health checks, automated CORS parsing, PM2 process configs, optimized Nginx buffer rules, and GitHub Actions CI.

---

## 🛠️ Tech Stack

- **Framework**: FastAPI, Uvicorn
- **Database ORM**: SQLAlchemy 2.0 (Async) + `asyncpg`
- **Machine Learning / AI**:
  - _Embeddings_: `sentence-transformers`
  - _Speech-to-Text_: `faster-whisper`
  - _Text-to-Speech_: `TTS`
  - _Vision/LLM Client_: `google-genai` / HTTP Client for Ollama & OpenAI compatibility
- **PDF Processing**: PyMuPDF (`fitz`), Pillow

---

## 📁 Folder Structure

```text
ai-service/
├── .github/workflows/    # CI/CD pipelines (located in repo root)
├── app/                  # Application Source Code
│   ├── api/              # API layer (v1 routes and Pydantic schemas)
│   │   └── v1/
│   │       ├── routes/   # Route handlers (chat, ocr, voice, summary, etc.)
│   │       └── schemas/  # Pydantic input/output validation models
│   ├── core/             # Shared system-wide configurations
│   │   ├── errors.py     # Custom exception classes and global handlers
│   │   ├── json_utils.py # Centralized JSON codeblock extraction utility
│   │   ├── lifecycle.py  # Lifespan startup/cleanup hooks
│   │   └── logging.py    # Structured logging with reserved-key guards
│   ├── infrastructure/   # Connector layers for external resources
│   │   ├── db/           # SQLAlchemy session and repository patterns
│   │   └── storage/      # AWS S3 and Google Cloud Storage clients
│   ├── modules/          # Domain services (chat, ocr, rag, embeddings, etc.)
│   ├── services/         # Client wrappers (AiClient, LLMService)
│   ├── container.py      # Dependency injection container
│   ├── main.py           # FastAPI entrypoint
│   └── settings.py       # Pydantic Settings env loader
├── deployment/           # Production configs (Nginx, PM2, Docker)
│   └── nginx.conf        # Reverse-proxy template
├── scripts/              # Windows PowerShell and cmd startup helpers
├── tests/                # Automated pytest suite
├── Dockerfile            # Production Docker image build instructions
├── docker-compose.yml    # Development multi-container environment
├── pm2.config.js         # PM2 Process management layout
├── pytest.ini            # Pytest execution settings
└── requirements.txt      # Python package dependencies list
```

---

## ⚙️ Environment Configuration

Copy the template file to create your environment configuration:

```bash
cp .env.example .env
```

### Required Configuration Fields

| Variable                   | Description                                   | Example / Default                             |
| :------------------------- | :-------------------------------------------- | :-------------------------------------------- |
| `DATABASE_URL`             | Async PG Database URL (pgvector required)     | `postgresql+asyncpg://user:pass@host:5432/db` |
| `STORAGE_PROVIDER`         | Object storage platform (`s3`, `gcp`, `auto`) | `s3`                                          |
| `PATIENT_DOCUMENTS_BUCKET` | Target bucket for patient records             | `patient-documents`                           |
| `AI_MODEL`                 | AI Completer / Vision identifier              | `qwen3-vl:latest`                             |
| `AI_BASE_URL`              | AI Completion gateway URL                     | `http://localhost:11434/v1`                   |
| `AI_API_KEY`               | Model API key (leave blank for local Ollama)  | `AI_API_KEY_HERE`                             |
| `CORS_ORIGINS`             | Comma-separated list of allowed CORS origins  | `*` or `http://localhost:3000`                |

---

## 🚀 Standalone Installation & Setup

Ensure you have **Python 3.11** installed.

### 1. Set Up Virtual Environment

**On Windows (Command Prompt):**

```cmd
py -3.11 -m venv venv
venv\Scripts\activate.bat
```

**On Linux / macOS:**

```bash
python3.11 -m venv venv
source venv/bin/activate
```

### 2. Install Dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

---

## 💻 Local Development Run

Ensure you have created the `.env` file and filled in the values.

### Option A: Using Helper Scripts (Windows)

Run from the `ai-service` root directory:

- **Command Prompt:** `scripts\run_dev.cmd`
- **PowerShell:** `.\scripts\run_dev.ps1`

### Option B: Direct Command Line

```bash
uvicorn app.main:app --host localhost --port 8000 --reload
```

The server will spin up on `http://localhost:8000`. You can verify execution by fetching the health check:

```bash
curl http://localhost:8000/v1/health
```

---

## 🐳 Docker Execution

### Using Docker Compose

A multi-container setup containing both the database (with `pgvector` preloaded) and the AI service:

```bash
docker-compose up --build -d
```

_Note: In the compose environment, `AI_BASE_URL` points to `host.docker.internal:11434` to transparently route to Ollama running on the host machine._

### Standalone Docker Image Build

```bash
docker build -t health-vault-ai-service .
docker run -p 8000:8000 --env-file .env health-vault-ai-service
```

---

## 🛡️ Production Deployment

### 1. Process Management (PM2)

Ensure PM2 is installed globally (`npm install -g pm2`). Start the service using the process descriptor:

```bash
pm2 start pm2.config.js
```

To run on a Windows server, open `pm2.config.js` and change `interpreter` to `./venv/Scripts/python.exe`.

### 2. Web Server (Nginx Reverse Proxy)

Copy the template configuration from `deployment/nginx.conf` to your Nginx sites directory (e.g. `/etc/nginx/sites-available/`).

Make sure to adjust the `client_max_body_size 25M;` line to accommodate your largest expected PDF or audio uploads, and ensure the WebSocket configuration for `/ws` handles connection upgrades correctly.

---

## 📝 API Documentation

FastAPI automatically generates interactive API documentation. Start the service and open the following URLs in your browser:

- **Interactive API Docs (Swagger UI)**: `http://localhost:8000/docs`
- **Detailed Static Docs (ReDoc)**: `http://localhost:8000/redoc`

---

## 🔧 Troubleshooting

### 1. PyMuPDF (fitz) Installation Issues on Windows

If you run into issues installing `pymupdf`, make sure you have the C++ Build Tools installed or try installing the pre-built wheel directly:

```bash
pip install pymupdf --only-binary :all:
```

### 2. Speech Models Loading Very Slowly (Whisper/TTS)

- **Hardware Acceleration**: By default, `faster-whisper` is configured with `device="auto"`. If a CUDA-enabled GPU is present on your machine, it will use GPU execution, drastically reducing synthesis times.
- **Warm-up Delay**: The very first synthesis or transcription request after a service reboot loads the model weights into memory. Subsequent calls run instantaneously. Use the `/v1/health` endpoint to verify embedding and storage availability.

---

## 📄 License

This project is licensed under the ISC License - see the parent `package.json` for details.
