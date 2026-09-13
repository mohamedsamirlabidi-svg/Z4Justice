# Mini ERM Platform

A monorepo ERP/ERM system focused on invoice operations for two business contexts:

- **Acrobate Solution**
- **GameStream ATLAS**

The platform ingests invoice files from local folders (`.pdf`, `.xls`, `.xlsx`, `.csv`), parses structured data, and persists clients/products/invoices into MongoDB.

---

## 1) What this project includes

- **Backend API** (`apps/backend`)
	- Express + Prisma + MongoDB
	- CRUD for clients/products/invoices
	- File ingestion and queue processing pipeline
	- Health endpoints and database diagnostics

- **Frontend Web App** (`apps/frontend`)
	- Next.js App Router
	- Dashboard and management pages for clients/products/invoices/files
	- Calls backend REST API directly

- **Flask Parser Service** (`services/flask-parser`) ⭐
	- Replaces legacy file-watcher with Python parser microservice
	- Watches local directories and parses files before sending structured invoices
	- Uses `openpyxl`/`pdfplumber`/OCR fallback for robust extraction
	- Pushes normalized payloads directly to `POST /api/invoices`

- **Infrastructure** (`infra`)
	- Docker Compose for MongoDB local development

---

## 2) Monorepo structure

```text
apps/
	backend/
	frontend/
services/
	file-watcher/
packages/
	shared-types/
infra/
README.md
package.json
```

### Root scripts

- `npm run dev` → runs backend + frontend + watcher concurrently
- `npm run build` → builds all workspaces
- `npm run lint` → runs workspace lint scripts if present
- `npm run format` → runs workspace format scripts if present

---

## 3) Technology stack

- **Language:** TypeScript
- **Backend:** Node.js, Express, Prisma
- **Frontend:** Next.js 15, React 19
- **File Parsing:** `pdf-parse`, `xlsx`, `jszip`
- **Watcher/Parser microservice:** Flask, watchdog, openpyxl, pdfplumber, pytesseract, pandas
- **Database:** MongoDB (Atlas or local Docker)

---

## 4) Environment configuration

### Backend (`apps/backend/.env`)

Based on `apps/backend/.env.example`:

- `DATABASE_URL` → MongoDB connection string
- `PORT` → backend port (default `4000`)
- `INGEST_API_KEY` → API key required by `/api/files/ingest`
- `OPENAI_API_KEY` *(optional)* → enables AI fallback parsing for difficult files
- `OPENAI_MODEL` *(optional)* → default `gpt-4.1-mini` in example
- `INGEST_CONCURRENCY` → parallelism for queued processing workers

### Frontend (`apps/frontend/.env`)

Based on `apps/frontend/.env.example`:

- `NEXT_PUBLIC_BACKEND_API_URL` → default `http://localhost:4000/api`

### Flask Parser (`services/flask-parser/.env`)

Based on `services/flask-parser/.env.example`:

- `WATCH_FOLDERS` → semicolon-separated absolute folder list
- `BACKEND_API_URL` → backend API base, e.g. `http://localhost:4000/api`
- `INGEST_API_KEY` → backend ingest key (forwarded in headers)
- `BACKFILL_ON_START` → whether parser scans existing files at startup
- `SYNC_REQUEST_TIMEOUT_SEC` → backend POST timeout in seconds
- `SYNC_RETRY_DELAY_SEC` → retry delay seconds
- `MAX_RETRY_ATTEMPTS` → send retry attempts
- `OPENAI_API_KEY` / `OPENAI_MODEL` → optional AI enrichment
- `FLASK_PORT` → parser API port (default `5100`)
- `LOG_LEVEL` → parser logging level

---

## 5) Getting started (local)

### A) Install dependencies

From repository root:

```bash
npm install
```

### B) Start MongoDB (local option)

The `infra/docker-compose.yml` spins up:

- MongoDB 7 container
- Port mapping: `27017:27017`

```bash
docker compose -f infra/docker-compose.yml up -d
```

### C) Prepare backend Prisma client/schema

```bash
npm run prisma:generate --workspace @mini-erm/backend
npm run prisma:migrate --workspace @mini-erm/backend
```

### D) Start all services

```bash
npm run dev
```

This runs:

- Backend (`@mini-erm/backend`)
- Frontend (`@mini-erm/frontend`)
- Flask parser service (`services/flask-parser/run.py`)

### Local URLs

- Frontend: `http://localhost:3000`
- Backend health: `http://localhost:4000/health`
- DB health: `http://localhost:4000/health/db`
- API base: `http://localhost:4000/api`

---

## 6) Backend deep dive

### Entry points

- `apps/backend/src/index.ts` → server bootstrap
- `apps/backend/src/app.ts` → express app, routes, error handling

### Registered route groups

- `/api/clients`
- `/api/products`
- `/api/invoices`
- `/api/files`

### Health endpoints

- `GET /health` → service status
- `GET /health/db` → MongoDB ping check

### Error model

Global error middleware maps:

- Prisma initialization failures → `503 DATABASE_UNAVAILABLE`
- Prisma known request errors → `400` + Prisma code
- Other errors → `500 INTERNAL_SERVER_ERROR`

### File ingest reliability improvements

`POST /api/files/ingest` now uses retry-safe upsert logic for transient transaction conflicts:

- Retries on `P2028`, `P2034`, write-conflict/deadlock patterns
- Configurable max attempts via `INGEST_UPSERT_MAX_ATTEMPTS` (default 5)
- Prevents watcher storms from crashing ingest persistence

---

## 7) API reference (current)

### Clients

- `GET /api/clients?company=...`
- `GET /api/clients/:id`
- `POST /api/clients`
- `PUT /api/clients/:id`
- `DELETE /api/clients/:id`

### Products

- `GET /api/products`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`

### Invoices

- `GET /api/invoices`
	- Optional filters: `company`, `clientId`, `status`
- `GET /api/invoices/:id`
- `POST /api/invoices`
- `PUT /api/invoices/:id`
- `DELETE /api/invoices/:id`

### Files / ingestion

- `GET /api/files`
- `POST /api/files/ingest`
	- Requires `x-ingest-key` when backend key is set
	- Body: `{ "fullPath": "C:/.../file.xlsx" }`
	- Optional query: `?processNow=true`
- `POST /api/files/process-queued?limit=...`
- `POST /api/files/migrate-all`
	- Body can include `{ folders: [...], processNow, includeProcessed }`
- `POST /api/files/:id/process`
- `DELETE /api/files/:id`

---

## 8) Ingestion pipeline details

### Step 1: Detection

Watcher detects file `add`/`change` events in configured folders and sends each supported path to backend ingest endpoint.

### Step 2: Queueing (`ImportedFile`)

Backend upserts by `fullPath` into `ImportedFile` with statuses such as:

- `queued`
- `processing`
- `processed`
- `failed`

### Step 3: Extraction (`extractors.ts`)

Supported formats:

- PDF (`pdf-parse`)
- Excel (`.xls`/`.xlsx` via `xlsx`)
- CSV

Excel extraction now captures:

- `rows`: structured rows mapped by inferred headers
- `allRows`: full line-by-line records (`sheet`, `row_index`, `column_#`) to preserve complete spreadsheet content
- `logoImages`: embedded image names discovered from `.xlsx` archive (`xl/media/*`) via `jszip`

### Step 4: Adapter parsing (`adapters.ts`)

- Company-aware parsing logic for Acrobate/GameStream
- Detects currency (defaults to `TND` in parser flow when unknown)
- Infers client/invoice hints from content/path/filename
- Builds line items from extracted rows
- Computes totals from text and row-level total lines

### Step 5: Optional AI fallback (`openai.ts`)

When extraction confidence is low, backend can call OpenAI and merge AI output with rule-based output.

AI prompt receives:

- text preview
- rows preview
- allRows preview
- discovered logo image names

### Step 6: Persistence (`service.ts`)

- Ensures/creates client
- Ensures/creates products
- Creates or updates invoice by `invoiceNo`
- Rewrites invoice items on update
- Stores ingestion notes and parser metadata

---

## 9) File Watcher deep dive

> Legacy note: this section documents the old Node watcher behavior retained in codebase for backward compatibility.
> The active recommended service is `services/flask-parser`.

## 9.1) Flask parser service (recommended)

`services/flask-parser` includes:

- `app/parsers/excel_parser.py` (template-aware coordinate extraction)
- `app/parsers/pdf_parser.py` (pdfplumber + OCR fallback)
- `app/parsers/csv_parser.py`
- `app/queue_manager.py` (background processing queue)
- `app/watcher.py` (watchdog-based file detection)
- `app/sender.py` (structured payload sender to backend `/api/invoices`)

Endpoints:

- `GET /health` (Flask parser health)
- `POST /trigger` (manual process path)

Run manually:

```bash
python services/flask-parser/run.py
```

Install parser dependencies:

```bash
pip install -r services/flask-parser/requirements.txt
```

### Behavior summary

- Waits for backend health before startup backfill
- Uses `ignoreInitial: true` to avoid duplicate startup storms
- Backfill performs controlled recursive scan and queueing
- Filters extensions to `.pdf`, `.xls`, `.xlsx`, `.csv`
- Skips temporary lock files such as:
	- `~$*.xlsx`
	- `._*`

### Reliability controls

- Normalizes ingest URL to remove accidental `processNow=true`
- Configurable request timeout (`SYNC_REQUEST_TIMEOUT_MS`)
- Retries failed sync attempts (connection refused/aborted/timeout)

---

## 10) Frontend deep dive

### API bridge

`apps/frontend/app/lib/api.ts`

- Reads `NEXT_PUBLIC_BACKEND_API_URL`
- Uses `fetch` with `cache: 'no-store'`
- Throws detailed errors for non-2xx responses

### Main pages

- `/` dashboard
- `/clients` and `/clients/[id]`
- `/products`
- `/invoices` and `/invoices/[id]`
- `/files`

Dashboard summarizes:

- total clients/invoices/products/imported files
- per-company counters and revenue (displayed in `TND`)

---

## 11) Data model overview (Prisma)

Core models:

- `Client`
- `Product`
- `Invoice`
- `InvoiceItem`
- `ImportedFile`

Invoice-related notable fields include:

- `invoiceNo`, `date`, `dueDate`, `status`
- `totalAmount`, `currency`, `sourceFile`
- company/contact/payment/tax metadata fields
- `notes` for parser/ingest metadata

---

## 12) Build & run commands

### Whole monorepo

```bash
npm run dev
npm run build
```

### Per workspace

```bash
npm run dev --workspace @mini-erm/backend
npm run dev --workspace @mini-erm/frontend
npm run dev --workspace @mini-erm/file-watcher
```

```bash
npm run build --workspace @mini-erm/backend
npm run build --workspace @mini-erm/frontend
npm run build --workspace @mini-erm/file-watcher
```

---

## 13) Troubleshooting guide

### 1) Port already in use (3000/4000)

- Stop existing Node processes and restart services.

### 2) Watcher `ECONNREFUSED`

- Backend is not ready yet.
- Ensure `/health` is reachable.

### 3) Watcher timeout/abort (`ECONNABORTED`, `ETIMEDOUT`)

- Increase `SYNC_REQUEST_TIMEOUT_MS`.
- Keep `BACKEND_INGEST_URL` without `processNow=true`.
- Let queue processing happen via `/api/files/process-queued` workers.

### 4) Prisma transaction abort (`P2028`)

- Retry-safe upsert is now implemented in files ingest route.
- If still present at high load, reduce watcher throughput and tune `INGEST_CONCURRENCY`.

### 5) Prisma client generate EPERM on Windows

- Stop running Node services first, then run `prisma generate` again.

---

## 14) Operational notes

- Use watcher for continuous ingest; use `process-queued` endpoint to drain queue in controlled batches.
- Keep `INGEST_API_KEY` consistent between backend and watcher.
- Prefer `.xlsx` over `.xls` when possible for richer metadata extraction (embedded media/logo discovery).

---

## 15) Current project status snapshot

Implemented and active:

- TND-focused currency normalization in ingestion flow
- Improved Excel heuristics and multi-sheet extraction
- Full-line extraction (`allRows`) for detailed ingestion fidelity
- Embedded logo/image metadata discovery for `.xlsx`
- Watcher startup/backfill hardening and timeout controls
- Retry-safe ingest upsert for transient Prisma transaction failures

This makes the platform resilient for high-volume historical folder backfills while preserving richer invoice detail in the pipeline.
