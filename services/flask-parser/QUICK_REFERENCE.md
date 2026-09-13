# Flask Parser - Quick Reference Guide

## 🚀 Getting Started (Windows)

```batch
cd services\flask-parser
setup.bat           # One-time: Install Python packages
start.bat           # Launch: Start the Flask service
verify.bat          # Test: Verify everything works
configure.bat       # Config: Manage settings
```

## 🚀 Getting Started (Linux/Mac)

```bash
cd services/flask-parser
bash setup.sh       # One-time: Install Python packages
bash start.sh       # Launch: Start the Flask service
bash start.sh       # Test: Verify everything works
```

## 📋 Common Tasks

### Configure Watch Folder
**Windows:**
```batch
configure.bat
# Select: [3] Edit .env file
# Add: WATCH_FOLDERS=C:\Your\Invoice\Path
```

**Linux/Mac:**
```bash
nano .env
# Edit: WATCH_FOLDERS=/home/user/invoices
```

### Test Backend Connection
```bash
# Windows
configure.bat [1]

# Linux/Mac
curl http://localhost:4000/health
```

### View Logs
```bash
# Windows
type logs\flask-parser.log

# Linux/Mac
tail -f logs/flask-parser.log
```

### Process Single File
```bash
curl -X POST http://localhost:5100/extract \
  -H "Content-Type: application/json" \
  -d '{"file_path": "C:\\invoices\\invoice.xlsx"}'
```

### Check Service Status
```bash
# Windows
netstat -ano | findstr :5100

# Linux/Mac
lsof -i :5100
```

## ⚙️ Configuration Quick Reference

| Setting | Purpose | Example |
|---------|---------|---------|
| `FLASK_PORT` | Service port | `5100` |
| `WATCH_FOLDERS` | Invoice directories | `C:\Invoices` |
| `BACKEND_API_URL` | Main API endpoint | `http://localhost:4000/api` |
| `BACKFILL_ON_START` | Scan existing files | `true` |
| `OPENAI_API_KEY` | AI enhancement (optional) | `sk-...` |

## 🔧 Troubleshooting Quick Fixes

### "Backend not responding" → Start npm run dev
```bash
# In your main ERMPLATFORM directory
npm run dev
```

### "Module not found" → Reinstall dependencies
```batch
setup.bat
```

### "Port already in use" → Change FLASK_PORT in .env
```
# Change from 5100 to 5101
FLASK_PORT=5101
```

### "Files not being processed" → Check WATCH_FOLDERS
```bash
# Verify the folder exists and parser has permission
dir C:\Your\Invoice\Path
```

### "AI extraction not working" → Check OPENAI_API_KEY
```bash
# Verify key is set correctly in .env
# Test with: python -c "from openai import OpenAI; OpenAI(api_key='your-key').models.list()"
```

## 📊 File Format Support

| Format | Status | Notes |
|--------|--------|-------|
| Excel (.xlsx) | ✅ Full | Recommended format |
| Excel (.xls) | ✅ Full | Legacy format support |
| PDF | ✅ Full | With text extraction + OCR fallback |
| CSV | ✅ Full | Delimiter auto-detection |

## 🔌 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Service status check |
| `/extract` | POST | Manual file extraction |
| (Automatic) | POST | Auto-sends to `/api/invoices` on backend |

## 💾 Folder Structure to Know

```
flask-parser/
├── .env                     # Configuration file
├── logs/                    # Log files
├── venv/                    # Python virtual environment (auto-created)
├── app/
│   ├── config.py           # Configuration loader
│   ├── openai_extractor.py # AI module
│   └── parsers/            # Format readers
└── routes/                 # API endpoints
```

## 🆘 When Things Go Wrong

### Check 1: Is Python installed?
```bash
python --version
```

### Check 2: Is venv created?
```bash
# Windows
if exist venv echo OK

# Linux/Mac
ls -la | grep venv
```

### Check 3: Are dependencies installed?
```bash
pip list | findstr flask
```

### Check 4: Is backend running?
```bash
curl http://localhost:4000/health
```

### Check 5: Can parser read watch folder?
```bash
# Windows - Test with a file
copy dummy.txt "C:\Your\Watch\Folder\test.txt"
```

## 🎯 Typical Workflow

1. **Setup** (First Time Only)
   ```bash
   setup.bat
   ```

2. **Configure**
   ```bash
   configure.bat → [3] Edit .env → Set WATCH_FOLDERS
   ```

3. **Verify**
   ```bash
   verify.bat
   ```

4. **Start Services**
   ```bash
   # Terminal 1: Main API
   npm run dev
   
   # Terminal 2: Flask Parser
   start.bat
   ```

5. **Place Invoices**
   ```bash
   Copy invoice files to WATCH_FOLDERS
   ```

6. **Monitor**
   ```bash
   # Check logs for processing status
   configure.bat → [5] View logs
   ```

## 📊 Expected Log Output

```
[2024-01-15 14:32:10] INFO: Flask parser started on port 5100
[2024-01-15 14:32:11] INFO: Backend available at http://localhost:4000/api
[2024-01-15 14:32:12] INFO: Watching folder: C:\Invoices
[2024-01-15 14:32:15] INFO: Detected file: invoice_001.xlsx
[2024-01-15 14:32:16] INFO: Parsing Excel file...
[2024-01-15 14:32:18] INFO: AI Enhancement: ✅ Enabled (OpenAI)
[2024-01-15 14:32:20] INFO: Sending to backend: /api/invoices
[2024-01-15 14:32:21] INFO: ✅ Success: Invoice INV-001 processed
```

## 🚫 Common Error Messages & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `Port 5100 already in use` | Another process on port | Change FLASK_PORT in .env |
| `No module named 'flask'` | Dependencies not installed | Run setup.bat |
| `Backend is OFFLINE` | Main API not running | Run `npm run dev` in main directory |
| `WATCH_FOLDERS not configured` | Configuration missing | Edit .env and set WATCH_FOLDERS |
| `Permission denied` | Can't read watch folder | Check folder permissions |
| `Invalid OPENAI_API_KEY` | Wrong API key | Verify key in .env and test connection |

## 💡 Pro Tips

- **Batch Processing**: Add multiple invoices at once - they queue automatically
- **Backfill on Start**: Set `BACKFILL_ON_START=true` to process existing invoices on restart
- **Fast Testing**: Use `configure.bat [1]` to quickly test backend connectivity
- **Debug Mode**: Set `LOG_LEVEL=DEBUG` for verbose logging
- **File Monitoring**: The watcher runs automatically - just drop files in WATCH_FOLDERS

## 🔗 Related Documentation

- **Full Setup Guide**: `DEPLOYMENT_GUIDE.md`
- **Architecture Overview**: See `docker-compose.yml` for service layout
- **Backend API**: Check main project `/api` routes
- **Invoice Data Format**: See `app/parsers/base_parser.py`

---

**Quick Links:**
- 📖 Full Documentation: [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
- 🐳 Docker Setup: [docker-compose.yml](docker-compose.yml)
- ⚙️ Configuration: [.env](.env)
- 📝 Main Readme: [README.md](README.md)

**Need Help?** Run `verify.bat` to diagnose issues!
