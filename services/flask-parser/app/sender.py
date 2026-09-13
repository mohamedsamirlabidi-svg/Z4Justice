import requests
import logging
import time
from datetime import datetime
from app.config import (
    BACKEND_API_URL, INGEST_API_KEY,
    SYNC_REQUEST_TIMEOUT_SEC, SYNC_RETRY_DELAY_SEC, MAX_RETRY_ATTEMPTS
)

logger = logging.getLogger(__name__)

FAILED_LOG = "failed_files.log"

def _record_failure(source_file: str, reason: str):
    stamp = datetime.utcnow().isoformat()
    with open(FAILED_LOG, "a", encoding="utf-8") as f:
        f.write(f"{stamp}\t{source_file}\t{reason}\n")

def send_invoice(invoice_data: dict, company: str, source_file: str) -> bool:
    """
    POST parsed invoice data directly to Node backend /api/invoices.
    Retries on failure with exponential backoff.
    """
    payload = {**invoice_data, "company": company}
    headers = {"Content-Type": "application/json"}
    if INGEST_API_KEY:
        headers["x-ingest-key"] = INGEST_API_KEY

    url = f"{BACKEND_API_URL}/invoices"
    last_reason = "unknown"

    for attempt in range(1, MAX_RETRY_ATTEMPTS + 1):
        try:
            resp = requests.post(
                url, json=payload, headers=headers,
                timeout=SYNC_REQUEST_TIMEOUT_SEC
            )
            if resp.status_code in (200, 201):
                logger.info(f"✅ Sent invoice {invoice_data.get('invoiceNo')} [{source_file}]")
                return True
            else:
                body_preview = (resp.text or "")[:300]
                last_reason = f"http_{resp.status_code}:{body_preview}"
                logger.warning(
                    f"⚠️  Backend returned {resp.status_code} (attempt {attempt}) for {source_file}: {body_preview}"
                )
        except requests.exceptions.RequestException as e:
            last_reason = f"request_error:{e}"
            logger.warning(f"⚠️  Request error (attempt {attempt}) for {source_file}: {e}")

        if attempt < MAX_RETRY_ATTEMPTS:
            time.sleep(SYNC_RETRY_DELAY_SEC * attempt)

    logger.error(f"❌ Failed to send {source_file} after {MAX_RETRY_ATTEMPTS} attempts ({last_reason})")
    _record_failure(source_file, last_reason)
    return False
