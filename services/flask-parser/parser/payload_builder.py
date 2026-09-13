import os,time
from datetime import datetime
from .utils import normalize_date,parse_number,detect_company,detect_currency
from .confidence import score_confidence
def build_payload(*,invoice_no,date_raw,total_raw,client,vat_raw,ht_raw,
                  items,source_path,extraction_method,raw_text=""):
    date_iso=normalize_date(date_raw)
    total_amt=parse_number(total_raw)
    vat_amt=parse_number(vat_raw)
    ht_amt=parse_number(ht_raw)
    company=detect_company(source_path)
    currency=detect_currency(text=raw_text,path=source_path)
    if total_amt==0 and ht_amt and vat_amt: total_amt=round(ht_amt+vat_amt,2)
    if ht_amt==0 and total_amt and vat_amt: ht_amt=round(total_amt-vat_amt,2)
    conf=score_confidence(invoice_no,date_raw,total_raw,client)
    return {
        "invoiceNo":invoice_no or f"PARSED-{int(time.time())}",
        "date":date_iso,"status":"pending","totalAmount":total_amt,
        "currency":currency,"sourceFile":os.path.basename(source_path),
        "notes":f"Flask parser v2 | {extraction_method}",
        "metadata":{"company":company,"clientName":client,"vatAmount":vat_amt,
            "amountExclVat":ht_amt,"extractionMethod":extraction_method,
            "confidence":conf,"parsedAt":datetime.utcnow().isoformat()+"Z",
            "aiEnriched":False},
        "items":items,"_raw_text":raw_text,
    }
