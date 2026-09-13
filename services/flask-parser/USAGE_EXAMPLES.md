# Flask Parser V2 - Usage Examples

## Quick Start

### 1. Start the Server

```bash
cd services/flask-parser
export FLASK_PORT=5100
export BACKEND_URL=http://localhost:4000/api
export OPENAI_API_KEY=sk-...  # Optional
python3 app.py
```

### 2. Parse Single File via API

```bash
# Upload an invoice
curl -X POST http://localhost:5100/parse \
  -F "file=@/path/to/invoice.xlsx"

# Response:
{
  "success": true,
  "invoice": {
    "invoiceNo": "2024-001",
    "date": "2024-03-15",
    "totalAmount": 1234.56,
    "currency": "TND",
    ...
  }
}
```

### 3. Batch Process Directory

```bash
curl -X POST http://localhost:5100/batch \
  -H "Content-Type: application/json" \
  -d '{"directory": "/path/to/invoices"}'

# Response:
{
  "processed": 42,
  "results": [
    {"file": "/path/to/invoice1.xlsx", "status": "ok"},
    {"file": "/path/to/invoice2.pdf", "status": "ok"},
    ...
  ]
}
```

## Direct Module Usage

### Excel Invoice

```python
from parser.excel_parser import extract_excel

payload = extract_excel("/path/to/invoice.xlsx")
print(f"Invoice: {payload['invoiceNo']}")
print(f"Total: {payload['totalAmount']} {payload['currency']}")
print(f"Confidence: {payload['metadata']['confidence']}")
```

### PDF Invoice (with OCR)

```python
from parser.pdf_parser import extract_pdf

payload = extract_pdf("/path/to/scanned_invoice.pdf")
# Automatically uses OCR if native text extraction fails
print(f"Method: {payload['metadata']['extractionMethod']}")
# Output: "pdf_hybrid_ocr" if OCR was used
```

### CSV Invoice

```python
from parser.csv_parser import extract_csv

payload = extract_csv("/path/to/invoice.csv")
print(f"Items: {len(payload['items'])}")
```

### AI Enrichment

```python
from parser.excel_parser import extract_excel
from parser.ai_enricher import enrich_with_ai
import os

os.environ["OPENAI_API_KEY"] = "sk-..."

payload = extract_excel("/path/to/invoice.xlsx")
payload = enrich_with_ai(payload)

if payload["metadata"]["aiEnriched"]:
    print("✓ AI corrected label leakage and filled missing fields")
```

### Sync to Backend

```python
from parser.excel_parser import extract_excel
from parser.sync import send_invoice

payload = extract_excel("/path/to/invoice.xlsx")
response = send_invoice(payload)
print(f"Synced to backend: {response}")
```

## File Watcher (Auto-Processing)

```python
from parser.watcher import start_watcher
import os

os.environ["WATCH_DIR"] = "./invoices"
start_watcher()
# Watches ./invoices directory
# Automatically processes new .xlsx, .xls, .pdf, .csv files
# Enriches with AI (if enabled)
# Syncs to backend
```

## Testing Examples

### Test Label Detection

```python
from parser.utils import is_label

print(is_label("Nom"))           # True - it's a label
print(is_label("Total TTC"))     # True - it's a label
print(is_label("2024-001"))      # False - invoice number
print(is_label("Acrobate SARL")) # Maybe True (short company name)
```

### Test Number Parsing

```python
from parser.utils import parse_number

# European format
print(parse_number("1 234,56"))  # 1234.56
print(parse_number("1.234,56"))  # 1234.56

# Simple formats
print(parse_number("1234.56"))   # 1234.56
print(parse_number("1234,56"))   # 1234.56
```

### Test Date Normalization

```python
from parser.utils import normalize_date

print(normalize_date("15/03/2024"))  # "2024-03-15"
print(normalize_date("2024-03-15"))  # "2024-03-15"
print(normalize_date("15-03-2024"))  # "2024-03-15"
```

### Test Confidence Scoring

```python
from parser.confidence import score_confidence

# High confidence (all fields present)
score = score_confidence(
    invoice_no="2024-001",
    date_raw="15/03/2024",
    total_raw="1234.56",
    client="Acrobate Solutions"
)
print(f"Confidence: {score}")  # ~1.0

# Low confidence (missing fields)
score = score_confidence(None, None, "1234.56", None)
print(f"Confidence: {score}")  # ~0.25 (only total present)
```

## Advanced Examples

### Custom Parser Pipeline

```python
from parser.excel_parser import extract_excel
from parser.ai_enricher import enrich_with_ai
from parser.utils import file_hash
import json

def process_invoice_advanced(path):
    # Step 1: Extract
    payload = extract_excel(path)

    # Step 2: Add file hash for deduplication
    payload["metadata"]["fileHash"] = file_hash(path)

    # Step 3: AI enrichment
    if payload["metadata"]["confidence"] < 0.8:
        payload = enrich_with_ai(payload)

    # Step 4: Custom validation
    if not payload["invoiceNo"]:
        payload["invoiceNo"] = f"MANUAL-{int(time.time())}"

    return payload

result = process_invoice_advanced("/path/to/invoice.xlsx")
print(json.dumps(result, indent=2))
```

### Parallel Batch Processing

```python
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from parser.excel_parser import extract_excel
from parser.pdf_parser import extract_pdf

PARSER_MAP = {".xlsx": extract_excel, ".xls": extract_excel, ".pdf": extract_pdf}

def process_file(path):
    ext = path.suffix.lower()
    if ext in PARSER_MAP:
        return PARSER_MAP[ext](str(path))
    return None

directory = Path("/path/to/invoices")
files = [f for f in directory.rglob("*") if f.suffix.lower() in PARSER_MAP]

with ThreadPoolExecutor(max_workers=4) as executor:
    results = list(executor.map(process_file, files))

print(f"Processed {len([r for r in results if r])} invoices")
```

### Company-Specific Processing

```python
from parser.utils import detect_company
from parser.excel_parser import extract_excel

def process_with_company_rules(path):
    payload = extract_excel(path)
    company = detect_company(path)

    if company == "ACROBATE_SOLUTION":
        # Custom rules for Acrobate
        payload["metadata"]["billingAddress"] = "Ariana, Tunisia"
        payload["currency"] = "TND"
    elif company == "GAMESTREAM_ATLAS":
        # Custom rules for GameStream
        payload["metadata"]["department"] = "Gaming"
        payload["currency"] = "EUR"

    return payload

result = process_with_company_rules("/invoices/ACROBATE_2024.xlsx")
print(f"Company: {result['metadata']['company']}")
```

### Export to Different Formats

```python
from parser.excel_parser import extract_excel
import json
import csv

payload = extract_excel("/path/to/invoice.xlsx")

# Export as JSON
with open("invoice.json", "w") as f:
    json.dump(payload, f, indent=2)

# Export line items as CSV
with open("items.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["description", "quantity", "unitPrice", "totalPrice"])
    writer.writeheader()
    writer.writerows(payload["items"])

print("✓ Exported invoice data")
```

## Environment Variables

```bash
# Server configuration
export FLASK_PORT=5100                       # Server port (default: 5100)
export BACKEND_URL=http://localhost:4000/api # Backend API URL

# AI enrichment (optional)
export OPENAI_API_KEY=sk-...                 # OpenAI API key for GPT-4o-mini

# File watcher (optional)
export WATCH_DIR=./invoices                  # Directory to watch for new files
```

## Troubleshooting Examples

### Debug Low Confidence

```python
from parser.excel_parser import extract_excel
from parser.utils import is_label

payload = extract_excel("/path/to/invoice.xlsx")

if payload["metadata"]["confidence"] < 0.7:
    print("⚠️ Low confidence detected")
    print(f"Invoice No: {payload['invoiceNo']} (is_label: {is_label(payload['invoiceNo'])})")
    print(f"Date: {payload['date']}")
    print(f"Total: {payload['totalAmount']}")
    print(f"Client: {payload['metadata']['clientName']}")
```

### Verify Label Filtering

```python
from parser.utils import is_label
from parser.constants import LABEL_BLOCKLIST

# Check if a value is being filtered
test_value = "Société Exemple"
print(f"'{test_value}' is_label: {is_label(test_value)}")
print(f"In blocklist: {test_value.lower() in LABEL_BLOCKLIST}")
```

### Test OCR Fallback

```python
from parser.pdf_parser import extract_pdf

# This will use OCR if native extraction fails
payload = extract_pdf("/path/to/scanned.pdf")

method = payload["metadata"]["extractionMethod"]
if "ocr" in method.lower():
    print("✓ OCR was used for this PDF")
else:
    print("✓ Native text extraction worked")
```

## Performance Benchmarks

```python
import time
from parser.excel_parser import extract_excel

# Benchmark single file
start = time.time()
payload = extract_excel("/path/to/invoice.xlsx")
duration = time.time() - start
print(f"Excel parsing: {duration*1000:.0f}ms")

# Benchmark batch (parallel)
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

files = list(Path("/path/to/invoices").glob("*.xlsx"))[:10]
start = time.time()

with ThreadPoolExecutor(max_workers=4) as executor:
    results = list(executor.map(extract_excel, [str(f) for f in files]))

duration = time.time() - start
print(f"Batch (10 files, 4 workers): {duration:.1f}s ({len(files)/duration:.1f} files/sec)")
```

## Migration from Old Parser

```python
# OLD CODE (app/parsers/)
from app.parsers.excel_parser import ExcelParser
parser = ExcelParser()
result = parser.parse("/path/to/invoice.xlsx")
payload = result.to_dict()

# NEW CODE (parser/)
from parser.excel_parser import extract_excel
payload = extract_excel("/path/to/invoice.xlsx")

# Payload is already a dict, no need to call to_dict()
```

## Common Patterns

### Validate Before Sending

```python
from parser.excel_parser import extract_excel
from parser.sync import send_invoice

payload = extract_excel("/path/to/invoice.xlsx")

# Validate required fields
if payload["invoiceNo"] and payload["date"] and payload["totalAmount"] > 0:
    response = send_invoice(payload)
    print("✓ Sent to backend")
else:
    print("✗ Invalid invoice data")
```

### Retry Failed Invoices

```python
from parser.excel_parser import extract_excel
from parser.sync import send_invoice
import time

def send_with_retry(payload, max_retries=3):
    for attempt in range(max_retries):
        result = send_invoice(payload)
        if result:
            return result
        time.sleep(2 ** attempt)  # Exponential backoff
    return None

payload = extract_excel("/path/to/invoice.xlsx")
result = send_with_retry(payload)
```
