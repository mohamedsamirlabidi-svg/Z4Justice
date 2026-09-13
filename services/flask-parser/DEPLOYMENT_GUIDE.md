# Flask Invoice Parser - Local Deployment Guide

Complete setup guide for deploying the Flask Invoice Parser backend on any local PC (Windows, Linux, macOS).

---

## 📋 Table of Contents

1. [Quick Start (Windows)](#quick-start-windows)
2. [Quick Start (Linux/macOS)](#quick-start-linuxmacos)
3. [Configuration](#configuration)
4. [How It Works](#how-it-works)
5. [Docker Deployment](#docker-deployment)
6. [Troubleshooting](#troubleshooting)
7. [File Structure](#file-structure)

---

## 🚀 Quick Start (Windows)

### Prerequisites
- Python 3.8 or higher ([Download](https://www.python.org/))
- Git (optional, for cloning the repository)

### Setup (One-Time)

1. **Open Command Prompt** and navigate to the Flask parser directory:
   ```cmd
   cd C:\Your\Path\ERMPLATFORM\services\flask-parser
   ```

2. **Run the setup script**:
   ```cmd
   setup.bat
   ```

   This will:
   - Create a Python virtual environment
   - Install all dependencies
   - Generate a `.env` configuration file

3. **Configure the `.env` file** (IMPORTANT):
   ```cmd
   notepad .env
   ```

   Edit these key settings:
   ```env
   # Path to your invoice files (semicolon-separated on Windows)
   WATCH_FOLDERS=C:\Invoices;C:\Users\YourName\Downloads\Factures
   
   # Your backend API URL (change if running on different host/port)
   BACKEND_API_URL=http://localhost:4000/api
   
   # Optional: OpenAI key for AI-enhanced extraction
   OPENAI_API_KEY=sk-your-key-here
   ```

4. **Create watch folder** if it doesn't exist:
   ```cmd
   mkdir C:\Invoices
   ```

### Run the Parser

Every time you want to start the parser:

```cmd
start.bat
```

You should see:
```
========================================
Flask Invoice Parser Starting...
========================================

Current Configuration:
---------------------
WATCH_FOLDERS=C:\Invoices
BACKEND_API_URL=http://localhost:4000/api
...

✅ Backend is available
Starting Flask Invoice Parser (listening on http://0.0.0.0:5100)...
```

---

## 🚀 Quick Start (Linux/macOS)

### Prerequisites
- Python 3.8 or higher
- pip (Python package manager)
- Bash shell

### Setup (One-Time)

1. **Navigate to the Flask parser directory**:
   ```bash
   cd /path/to/ERMPLATFORM/services/flask-parser
   ```

2. **Make scripts executable**:
   ```bash
   chmod +x setup.sh start.sh
   ```

3. **Run the setup script**:
   ```bash
   ./setup.sh
   ```

   This will:
   - Create a Python virtual environment
   - Install all dependencies
   - Generate a `.env` configuration file

4. **Configure the `.env` file** (IMPORTANT):
   ```bash
   nano .env
   # or
   vim .env
   ```

   Edit these key settings:
   ```env
   # Paths to your invoice folders (colon-separated on Linux/Mac)
   WATCH_FOLDERS=/home/user/invoices:/mnt/shared/factures
   
   # Your backend API URL
   BACKEND_API_URL=http://localhost:4000/api
   
   # Optional: OpenAI key for AI-enhanced extraction
   OPENAI_API_KEY=sk-your-key-here
   ```

5. **Create watch folder** if it doesn't exist:
   ```bash
   mkdir -p ~/invoices
   ```

### Run the Parser

Every time you want to start the parser:

```bash
./start.sh
```

You should see:
```
========================================
Flask Invoice Parser Starting...
========================================

Current Configuration:
---------------------
WATCH_FOLDERS=/home/user/invoices
BACKEND_API_URL=http://localhost:4000/api
...

✅ Backend is available
Starting Flask Invoice Parser...
Listening on http://0.0.0.0:5100
```

---

## ⚙️ Configuration

### .env Variables Explained

| Variable | Description | Example |
|----------|-------------|---------|
| `FLASK_PORT` | Flask server port | `5100` |
| `LOG_LEVEL` | Logging verbosity (DEBUG/INFO/WARNING/ERROR) | `INFO` |
| `WATCH_FOLDERS` | Directories to monitor for invoice files | `C:\Invoices;D:\Downloads` |
| `BACKEND_API_URL` | Node.js backend API endpoint | `http://localhost:4000/api` |
| `INGEST_API_KEY` | Optional authentication key | (leave blank if not required) |
| `BACKFILL_ON_START` | Scan existing files on startup | `true` |
| `SYNC_REQUEST_TIMEOUT_SEC` | API request timeout | `120` |
| `SYNC_RETRY_DELAY_SEC` | Delay between retry attempts | `5` |
| `MAX_RETRY_ATTEMPTS` | Number of upload retries | `3` |
| `OPENAI_API_KEY` | OpenAI API key for AI extraction | `sk-...` |
| `OPENAI_MODEL` | OpenAI model to use | `gpt-4-vision-preview` |

### Multiple Watch Folders

**Windows** (semicolon-separated):
```env
WATCH_FOLDERS=C:\Invoices;D:\Documents\Factures;E:\SharedFolder\Bills
```

**Linux/Mac** (colon-separated):
```env
WATCH_FOLDERS=/home/user/invoices:/mnt/shared/factures:/var/invoices
```

---

## 🔄 How It Works

```
┌─────────────────────────────────────────┐
│   Local Invoice Files (Watch Folder)    │
│  C:\Invoices\invoice_2025.xlsx          │
│  C:\Invoices\facture_01.pdf             │
└────────────┬────────────────────────────┘
             │
             ▼ (File Detected)
┌─────────────────────────────────────────┐
│    Flask Parser Processing               │
│  - PDF/XLSX/CSV file detected           │
│  - Regex extraction (fast)              │
│  - AI validation (optional)             │
│  - Data enrichment                      │
└────────────┬────────────────────────────┘
             │
             ▼ (HTTP POST)
┌─────────────────────────────────────────┐
│   Backend API (Node.js)                  │
│  POST http://localhost:4000/api/invoices │
│  Payload: Invoice JSON data             │
└────────────┬────────────────────────────┘
             │
             ▼ (Database Save)
┌─────────────────────────────────────────┐
│   MongoDB Database                      │
│  Collections:                           │
│  - invoices                             │
│  - imported_files                       │
└─────────────────────────────────────────┘
```

### File Processing Steps

1. **File Detection**: Parser watches for new/modified files
2. **Format Detection**: Identifies file type (PDF, XLSX, CSV)
3. **Extraction**: Extracts data using regex patterns
4. **AI Enhancement** (optional): Validates with OpenAI if configured
5. **Enrichment**: Adds metadata (company, timestamp, confidence)
6. **Upload**: POSTs data to backend API
7. **Database Save**: Backend stores in MongoDB

### Extracted Data Fields

- Invoice number & date
- Client information (name, address, country)
- Line items (reference, description, quantity, unit price, amount)
- Financial totals (Base HT, VAT/Tax, Fiscal Stamp, Total TTC)
- Payment information (method, terms, bank, RIB)
- Responsible person & amount in words
- Company/seller details
- Extraction metadata & confidence score

---

## 🐳 Docker Deployment

### Prerequisites
- Docker ([Download](https://www.docker.com/))
- Docker Compose (usually included with Docker Desktop)

### Setup with Docker

1. **Configure .env file**:
   ```bash
   # Same as above, set WATCH_FOLDERS and BACKEND_API_URL
   ```

2. **Build images**:
   ```bash
   docker-compose build
   ```

3. **Start services**:
   ```bash
   docker-compose up -d
   ```

4. **Verify services running**:
   ```bash
   docker-compose ps
   ```

### Docker File Structure

```
ERMPLATFORM/
├── services/
│   └── flask-parser/
│       ├── .env                 # Your configuration
│       ├── watch/               # Mount for watch folders
│       ├── logs/                # Parser logs
│       ├── requirements.txt
│       ├── run.py
│       ├── Dockerfile
│       └── docker-compose.yml
```

### Docker Logs

View parser logs:
```bash
docker-compose logs -f flask-parser
```

View backend logs:
```bash
docker-compose logs -f backend
```

### Stop Services

```bash
docker-compose down
```

---

## 🐛 Troubleshooting

### Issue: "WATCH_FOLDERS is empty"

**Problem**: Parser starts but doesn't monitor any files.

**Solution**: 
1. Edit `.env` and set `WATCH_FOLDERS`
2. Restart the parser

```env
# Windows example
WATCH_FOLDERS=C:\Invoices

# Linux/Mac example
WATCH_FOLDERS=/home/user/invoices
```

### Issue: "Backend is offline" or "Connection refused"

**Problem**: Parser can't reach the backend API.

**Solution**:
1. Ensure backend is running on the correct port:
   ```bash
   # Backend should be running on port 4000
   curl http://localhost:4000/health
   ```

2. Check `BACKEND_API_URL` in `.env`:
   ```env
   BACKEND_API_URL=http://localhost:4000/api
   ```

3. If using Docker, use correct hostname:
   ```env
   BACKEND_API_URL=http://backend:4000/api
   ```

### Issue: "File keeps getting reprocessed"

**Problem**: Same file processed multiple times.

**Solution**: Parser watches for file modifications. To prevent re-processing:
- Move completed files to a `processed/` subfolder
- Or use `.tmp` extension while creating files (automatically skipped)

### Issue: "No invoice data extracted"

**Problem**: Files detected but no data extracted.

**Solution**:
1. Check file format is supported (PDF, XLSX, CSV)
2. Verify file is not corrupted
3. Check logs for parsing errors:
   ```bash
   # Windows
   type logs/parser.log
   
   # Linux/Mac
   cat logs/parser.log
   ```

4. Try with AI enhancement (if configured):
   - Set valid `OPENAI_API_KEY` in `.env`
   - Restart parser

### Issue: OpenAI API errors

**Problem**: "Invalid API key" or "Rate limit exceeded"

**Solution**:
1. Verify API key is valid and has credits
2. Check key format (should start with `sk-`)
3. Temporarily disable AI extraction:
   ```env
   OPENAI_API_KEY=
   ```

### Issue: Permission denied on Linux/Mac

**Problem**: "Permission denied" when running shell scripts.

**Solution**:
```bash
chmod +x setup.sh start.sh
```

---

## 📂 File Structure

```
services/flask-parser/
├── .env                          # Configuration (YOU edit this)
├── .env.example                  # Configuration template
├── requirements.txt              # Python dependencies
├── run.py                        # Main entry point
├── setup.bat                     # Windows setup script
├── setup.sh                      # Linux/Mac setup script
├── start.bat                     # Windows launcher
├── start.sh                      # Linux/Mac launcher
├── Dockerfile                    # Docker image definition
├── docker-compose.yml            # Docker services definition
├── README.md                     # This file
│
├── app/
│   ├── __init__.py
│   ├── config.py                 # Configuration loader
│   ├── watcher.py                # File watcher logic
│   ├── sender.py                 # Database API sender
│   ├── queue_manager.py          # Processing queue
│   ├── openai_extractor.py       # AI extraction module
│   │
│   ├── parsers/
│   │   ├── base_parser.py        # Base parser class
│   │   ├── excel_parser.py       # XLSX/XLS parser
│   │   ├── pdf_parser.py         # PDF parser
│   │   └── csv_parser.py         # CSV parser
│   │
│   └── adapters/
│       ├── detector.py           # Company detection
│       ├── gamestream_adapter.py # GameStream enrichments
│       └── acrobate_adapter.py   # Acrobate enrichments
│
├── routes/
│   ├── health.py                 # Health check endpoint
│   └── trigger.py                # Manual trigger endpoint
│
├── watch/                        # Mount point for invoice files (Docker)
├── logs/                         # Parser logs
├── data/                         # Persistent data
└── .venv/                        # Virtual environment (auto-created)
```

---

## ✅ Verification Checklist

After setup, verify everything works:

- [ ] Setup completed without errors
- [ ] `.env` file configured with watch folder path
- [ ] Backend is running (`curl http://localhost:4000/health`)
- [ ] Parser starts successfully (`start.bat` or `./start.sh`)
- [ ] Parser shows "Backend is available"
- [ ] Place a test invoice file in watch folder
- [ ] Parser detects the file: "📥 New file detected"
- [ ] Data appears in backend API response

---

## 🆘 Support

If you encounter issues:

1. **Check logs**: Look for detailed error messages
2. **Verify configuration**: Ensure `.env` is correctly set
3. **Test connectivity**: Verify backend is reachable
4. **Read error messages**: They usually indicate the problem
5. **Check file formats**: Ensure files are PDF/XLSX/CSV, not corrupted

---

## 📞 Next Steps

- Place your invoice files in the configured `WATCH_FOLDERS`
- Monitor the parser logs for successful extraction
- Verify invoices appear in the backend API/database
- Use the admin dashboard to review extracted data
- Configure OpenAI API key for enhanced accuracy (optional)

Happy invoicing! 🎉
