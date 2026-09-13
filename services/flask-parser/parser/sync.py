import requests,logging,os
logger=logging.getLogger(__name__)
BACKEND_URL=os.getenv("BACKEND_URL","http://localhost:4000/api")
def send_invoice(payload):
    try:
        payload.pop("_raw_text",None)
        resp=requests.post(f"{BACKEND_URL}/invoices",json=payload,timeout=10)
        resp.raise_for_status()
        logger.info(f"Sent {payload['invoiceNo']} to backend: {resp.status_code}")
        return resp.json()
    except Exception as e:
        logger.error(f"Failed to send {payload.get('invoiceNo')}: {e}")
        return None
