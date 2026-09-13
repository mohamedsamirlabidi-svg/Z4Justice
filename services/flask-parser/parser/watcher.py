import os
import time
import logging
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

logger = logging.getLogger(__name__)

WATCH_DIR = os.getenv("WATCH_DIR", "./invoices")
PARSER_EXTS = {".xlsx", ".xls", ".pdf", ".csv"}


class InvoiceHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        path = event.src_path
        ext = Path(path).suffix.lower()
        if ext not in PARSER_EXTS:
            return
        # Small delay to let the file finish writing
        time.sleep(0.5)
        try:
            logger.info(f"Processing new file: {path}")
            # Import here to avoid circular imports
            from app import parse_and_enrich
            from parser.sync import send_invoice

            payload = parse_and_enrich(path)
            send_invoice(payload)
            logger.info(f"Successfully processed: {path}")
        except Exception as e:
            logger.error(f"Error processing {path}: {e}")


def start_watcher():
    Path(WATCH_DIR).mkdir(parents=True, exist_ok=True)
    handler = InvoiceHandler()
    observer = Observer()
    observer.schedule(handler, WATCH_DIR, recursive=False)
    observer.start()
    logger.info(f"Watching {WATCH_DIR} for invoice files")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
