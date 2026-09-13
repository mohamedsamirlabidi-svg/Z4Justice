# Flask Parser - Invoice Extraction Engine

A powerful, intelligent Flask-based service that automatically extracts data from invoices in multiple formats (Excel, PDF, CSV) and sends them to your invoice management backend. Features AI-powered validation and payment method detection.

## 🚀 Quick Start

### Windows
```bash
# First time setup
setup.bat

# Start the service
start.bat

# Configure and test
configure.bat

# Verify installation
verify.bat
```

### Linux/Mac
```bash
# First time setup
bash setup.sh

# Start the service
bash start.sh

# Configure and test
python -m app.config
```

## 📋 Features

- **Multi-Format Support**: Excel (XLSX, XLS), PDF, CSV
- **AI-Powered Extraction**: OpenAI Vision API integration
- **Intelligent Validation**: Automatic data correction and field validation
- **Payment Method Detection**: Recognizes payment types (Comptant, Chèque)
- **Real-Time Monitoring**: Watchdog-based file monitoring with automatic processing
- **Retry Logic**: Automatic retry with configurable backoff strategy
- **Comprehensive Logging**: Detailed logs for debugging and monitoring
- **Docker Ready**: Pre-configured Docker Compose for containerized deployment

## 🔧 Configuration

### Environment Variables (.env)

| Variable | Description | Default |
|----------|-------------|---------|
| `FLASK_PORT` | Flask server port | `5100` |
| `LOG_LEVEL` | Logging level (DEBUG, INFO, WARNING, ERROR) | `INFO` |
| `BACKEND_API_URL` | Invoice backend API endpoint | `http://localhost:4000/api` |
| `INGEST_API_KEY` | Authentication key for backend (if required) | (empty) |
| `WATCH_FOLDERS` | Invoice directory paths (semicolon-separated on Windows) | (empty) |
| `BACKFILL_ON_START` | Scan existing files on startup | `true` |
| `SYNC_REQUEST_TIMEOUT_SEC` | Backend request timeout | `120` |
| `SYNC_RETRY_DELAY_SEC` | Delay between retries | `5` |
| `MAX_RETRY_ATTEMPTS` | Maximum retry attempts | `3` |
| `OPENAI_API_KEY` | OpenAI API key for AI extraction | (empty) |
| `OPENAI_MODEL` | OpenAI model to use | `gpt-4-vision-preview` |

### Setting Up Watch Folders

Edit `.env` and configure the `WATCH_FOLDERS` variable:

**Windows:**
```
WATCH_FOLDERS=C:\Invoices;D:\Shared\Invoices
```

**Linux/Mac:**
```
WATCH_FOLDERS=/home/user/Invoices:/mnt/shared/Invoices
```

## 📁 File Structure

```
flask-parser/
├── app/
│   ├── __init__.py              # Flask app factory
│   ├── config.py                # Configuration loader
│   ├── openai_extractor.py      # AI extraction module
│   ├── queue_manager.py         # File queue management
│   ├── sender.py                # Backend API communication
│   ├── watcher.py               # File monitoring
│   ├── adapters/                # Format-specific adapters
│   │   ├── gamestream_adapter.py
│   │   └── acrobate_adapter.py
│   └── parsers/                 # Invoice parsers
│       ├── base_parser.py
│       ├── excel_parser.py
│       ├── pdf_parser.py
│       └── csv_parser.py
├── routes/
│   ├── health.py                # Health check endpoint
│   └── trigger.py               # Manual trigger endpoint
├── setup.bat / setup.sh         # Setup scripts
├── start.bat / start.sh         # Launch scripts
├── verify.bat                   # Verification script
├── configure.bat                # Configuration tool
├── docker-compose.yml           # Docker deployment
└── requirements.txt             # Python dependencies
```

## 🔌 API Integration

### Extract Invoice (Manual Trigger)
```bash
curl -X POST http://localhost:5100/extract \
  -H "Content-Type: application/json" \
  -d '{"file_path": "/path/to/invoice.xlsx"}'
```

### Health Check
```bash
curl http://localhost:5100/health
```

### Backend Integration
The service automatically sends extracted invoices to:
```
POST {BACKEND_API_URL}/invoices
Content-Type: application/json

{
  "invoiceNumber": "INV-001",
  "date": "2024-01-15",
  "commandeNo": "CMD-123",
  "responsable": "John Doe",
  "items": [...],
  "total": 1500.00,
  "paymentMethod": "COMPTANT",
  "aiEnhanced": true,
  "aiConfidence": 0.95
}
```

## 📊 Data Extraction

### Supported Fields

| Field | Excel | PDF | CSV |
|-------|-------|-----|-----|
| Invoice Number | ✅ | ✅ | ✅ |
| Date | ✅ | ✅ | ✅ |
| Order Number (Commande) | ✅ | ✅ | ✅ |
| Responsible Person | ✅ | ✅ | ✅ |
| Line Items | ✅ | ✅ | ✅ |
| Totals (HT, TTC, Tax) | ✅ | ✅ | ✅ |
| Payment Method | ✅ | ✅ | ✅ |

### AI Enhancement

When `OPENAI_API_KEY` is configured, the service:
1. Validates extracted data
2. Corrects formatting errors
3. Detects payment methods from checksmarks/text
4. Extracts table items with high confidence
5. Calculates confidence scores for each field
6. Provides fallback for missing fields

## 🐳 Docker Deployment

### Using Docker Compose
```bash
# Build and start
docker-compose -f docker-compose.yml up --build

# View logs
docker-compose logs -f flask-parser

# Stop services
docker-compose down
```

### Using Docker CLI
```bash
# Build image
docker build -t flask-parser .

# Run container
docker run -p 5100:5100 \
  -v /path/to/invoices:/data/invoices \
  -e WATCH_FOLDERS=/data/invoices \
  -e BACKEND_API_URL=http://host.docker.internal:4000/api \
  flask-parser
```

## 🧪 Testing & Verification

### Verify Installation
```bash
# Windows
verify.bat

# Linux/Mac
bash verify.bat  # or use configure menu
```

### Manual Testing
```bash
# Test a specific file
python -c "
from app.parsers.excel_parser import ExcelParser
parser = ExcelParser('/path/to/invoice.xlsx')
result = parser.parse()
print(result.to_dict())
"

# Test backend connectivity
python -c "
import requests
response = requests.get('http://localhost:4000/health')
print(f'Backend: {response.status_code}')
"
```

## 📝 Logging

Logs are saved to:
- **Windows**: `logs/flask-parser.log`
- **Linux/Mac**: `logs/flask-parser.log`

### Viewing Logs
```bash
# Windows
start logs\flask-parser.log

# Linux/Mac
tail -f logs/flask-parser.log
```

## 🆘 Troubleshooting

### Backend Not Responding
```
Error: Backend unreachable at http://localhost:4000/api
Solution:
1. Check if npm run dev is running in the main project
2. Verify port 4000 is not blocked
3. Check firewall settings
```

### Files Not Being Processed
```
Error: Files appear in watch folder but not processed
Solution:
1. Verify WATCH_FOLDERS is configured in .env
2. Check file permissions (parser must read the folder)
3. Ensure file format is supported (xlsx, pdf, csv)
4. Check logs for error messages
```

### OpenAI API Errors
```
Error: Invalid OpenAI API key
Solution:
1. Verify OPENAI_API_KEY in .env
2. Check key has vision capabilities enabled
3. Ensure API account has credits
4. Try disabling AI features (leave OPENAI_API_KEY empty)
```

### Python/Package Errors
```
Error: ModuleNotFoundError: No module named 'openpyxl'
Solution:
1. Run: pip install -r requirements.txt
2. Or re-run setup.bat/setup.sh
3. Verify virtual environment is activated
```

## 📈 Performance Tips

1. **Batch Processing**: Place multiple invoices in watch folder - they'll be processed sequentially
2. **Retry Configuration**: Adjust `SYNC_RETRY_DELAY_SEC` and `MAX_RETRY_ATTEMPTS` if backend is slow
3. **AI Caching**: AI extraction results are cached to reduce API costs
4. **File Cleanup**: Move processed files to prevent re-processing

## 🔒 Security Notes

- **API Keys**: Never commit `.env` file with API keys to version control
- **Watch Folder**: Restrict access to invoice watch folders
- **Backend Auth**: Use `INGEST_API_KEY` if backend requires authentication
- **Timeout**: Increase `SYNC_REQUEST_TIMEOUT_SEC` for large invoices

## 📞 Support

For issues or questions:
1. Check logs in `logs/flask-parser.log`
2. Run `verify.bat` to diagnose setup issues
3. Review `DEPLOYMENT_GUIDE.md` for detailed documentation
4. Check backend logs for data ingestion errors

## 📄 License

Part of the ERM Platform invoice management system.

## ✨ Recent Updates

- ✅ AI-powered data extraction and validation
- ✅ Payment method detection (Comptant, Chèque)
- ✅ Windows/Linux/Mac setup automation
- ✅ Docker deployment support
- ✅ Comprehensive error handling and logging
- ✅ Configuration management tools
- ✅ Verification and diagnostic tools

---

**Version**: 2.0+AI
**Last Updated**: 2024
**Status**: Production Ready
