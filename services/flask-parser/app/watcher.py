import os
import logging
import time
import requests
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from app.config import (
    WATCH_FOLDERS, SUPPORTED_EXTENSIONS, SKIP_PATTERNS,
    BACKFILL_ON_START, BACKEND_API_URL, SYNC_RETRY_DELAY_SEC
)
from app.queue_manager import enqueue

logger = logging.getLogger(__name__)

def _should_process(file_path: str) -> bool:
    name = os.path.basename(file_path)
    ext = Path(file_path).suffix.lower()
    if any(name.startswith(p) for p in SKIP_PATTERNS):
        return False
    return ext in SUPPORTED_EXTENSIONS

class InvoiceHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory and _should_process(event.src_path):
            logger.info(f"📥 New file detected: {event.src_path}")
            enqueue(event.src_path)

    def on_modified(self, event):
        if not event.is_directory and _should_process(event.src_path):
            logger.info(f"📝 File modified: {event.src_path}")
            enqueue(event.src_path)

def wait_for_backend(timeout_sec: int = 60):
    url = f"{BACKEND_API_URL.rstrip('/api').rstrip('/')}/health"
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                logger.info("✅ Backend is ready")
                return True
        except Exception:
            pass
        logger.info("⏳ Waiting for backend...")
        time.sleep(SYNC_RETRY_DELAY_SEC)
    logger.warning("⚠️  Backend did not become ready in time — starting anyway")
    return False

def backfill():
    logger.info("🔍 Starting backfill scan...")
    count = 0
    for folder in WATCH_FOLDERS:
        if not os.path.isdir(folder):
            logger.warning(f"⚠️  Watch folder not found: {folder}")
            continue
        for root, _, files in os.walk(folder):
            for fname in files:
                full_path = os.path.join(root, fname)
                if _should_process(full_path):
                    enqueue(full_path)
                    count += 1
    logger.info(f"✅ Backfill enqueued {count} files")

def start_watcher():
    observer = Observer()
    handler = InvoiceHandler()
    for folder in WATCH_FOLDERS:
        if os.path.isdir(folder):
            observer.schedule(handler, folder, recursive=True)
            logger.info(f"👀 Watching: {folder}")
        else:
            logger.warning(f"⚠️  Folder does not exist: {folder}")
    observer.start()
    return observer
