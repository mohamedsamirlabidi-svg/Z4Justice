import os
from dotenv import load_dotenv

load_dotenv()

WATCH_FOLDERS = [
    f.strip() for f in
    os.getenv("WATCH_FOLDERS", os.getenv("WATCH_FOLDER", "")).split(";")
    if f.strip()
]
BACKEND_API_URL = os.getenv("BACKEND_API_URL", "http://localhost:4000/api")
INGEST_API_KEY = os.getenv("INGEST_API_KEY", "")
BACKFILL_ON_START = os.getenv("BACKFILL_ON_START", "true").lower() == "true"
SYNC_REQUEST_TIMEOUT_SEC = int(os.getenv("SYNC_REQUEST_TIMEOUT_SEC", "120"))
SYNC_RETRY_DELAY_SEC = int(os.getenv("SYNC_RETRY_DELAY_SEC", "5"))
MAX_RETRY_ATTEMPTS = int(os.getenv("MAX_RETRY_ATTEMPTS", "3"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
FLASK_PORT = int(os.getenv("FLASK_PORT", "5100"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
SUPPORTED_EXTENSIONS = {".pdf", ".xlsx", ".xls", ".csv"}
SKIP_PATTERNS = ("~$", "._", ".tmp")
