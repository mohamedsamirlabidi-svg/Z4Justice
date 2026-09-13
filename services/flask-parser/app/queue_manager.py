import threading
import logging
from app.parsers.excel_parser import ExcelParser
from app.parsers.pdf_parser import PdfParser
from app.parsers.csv_parser import CsvParser
from app.adapters.detector import detect_company
from app.sender import send_invoice

logger = logging.getLogger(__name__)

_queue: list[str] = []
_lock = threading.Lock()
_worker_thread: threading.Thread | None = None

PARSERS = [ExcelParser(), PdfParser(), CsvParser()]

def enqueue(file_path: str):
    with _lock:
        if file_path not in _queue:
            _queue.append(file_path)

def _worker():
    while True:
        file_path = None
        with _lock:
            if _queue:
                file_path = _queue.pop(0)
        if file_path:
            _process(file_path)
        else:
            import time
            time.sleep(1)

def _process(file_path: str):
    logger.info(f"⚙️  Processing: {file_path}")
    parser = next((p for p in PARSERS if p.can_parse(file_path)), None)
    if not parser:
        logger.warning(f"No parser for: {file_path}")
        return
    try:
        result = parser.parse(file_path)
        company = detect_company(file_path, result.raw_text)
        invoice_dict = result.to_dict()
        invoice_dict["company"] = company
        sent = send_invoice(invoice_dict, company, file_path)
        if not sent:
            logger.error(f"❌ Failed to deliver parsed invoice to backend: {file_path}")
    except Exception as e:
        logger.error(f"❌ Error processing {file_path}: {e}", exc_info=True)

def start_worker():
    global _worker_thread
    _worker_thread = threading.Thread(target=_worker, daemon=True)
    _worker_thread.start()
    logger.info("✅ Queue worker started")
