import re, hashlib
from datetime import datetime
from .constants import (RE_LABEL_STRIP,RE_AMOUNT,RE_CURRENCY,RE_VAT,
    RE_INVOICE_NO,RE_DATE,RE_DATETIME,LABEL_BLOCKLIST,DATE_FORMATS,TOTAL_ANCHORS,CLIENT_ANCHORS)
def file_hash(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(65536),b""):h.update(chunk)
    return h.hexdigest()
def is_label(value):
    if not value: return True
    v=value.strip().lower().rstrip(":").strip()
    if v in LABEL_BLOCKLIST: return True
    if RE_LABEL_STRIP.match(v) and len(v)<25 and not any(c.isdigit() for c in v): return True
    return False
def parse_number(val):
    if val is None: return 0.0
    s=str(val).strip().replace(" ","").replace("\xa0","")
    if re.match(r'^\d{1,3}(\.\d{3})+(,\d+)?$',s): s=s.replace(".","").replace(",",".")
    else: s=s.replace(",",".")
    try: return float(re.sub(r"[^\d.]","",s))
    except: return 0.0
def normalize_date(raw):
    if not raw: return None

    # Handle datetime objects directly
    if isinstance(raw, datetime):
        return raw.strftime("%Y-%m-%d")

    raw_str = str(raw).strip()

    # Check if it's already in datetime format (from Excel)
    if RE_DATETIME.match(raw_str):
        return raw_str.split()[0]

    for fmt in DATE_FORMATS:
        try: return datetime.strptime(raw_str,fmt).strftime("%Y-%m-%d")
        except ValueError: continue
    return None
def detect_company(path):
    p=path.upper()
    if "ACROBATE" in p: return "ACROBATE_SOLUTION"
    if "GAMESTREAM" in p or "ATLAS" in p: return "GAMESTREAM_ATLAS"
    return "UNKNOWN"
def detect_currency(text="",path=""):
    m=RE_CURRENCY.search(text)
    if m:
        raw=m.group(1).upper()
        return {"€":"EUR","$":"USD","DT":"TND"}.get(raw,raw)
    p=path.upper()
    if "TND" in p or "TUNISIE" in p: return "TND"
    if "MAD" in p or "MAROC" in p: return "MAD"
    return "EUR"
def extract_invoice_no(text):
    m=RE_INVOICE_NO.search(text)
    return m.group(1).strip() if m else None
def extract_date(text):
    m=RE_DATE.search(text)
    return m.group(1) if m else None
def extract_total(text):
    tl=text.lower()
    for anchor in TOTAL_ANCHORS:
        idx=tl.find(anchor)
        if idx!=-1:
            m=RE_AMOUNT.search(text[idx:idx+80])
            if m: return m.group().replace(" ","").replace(",",".")
    all_a=RE_AMOUNT.findall(text)
    return str(max(parse_number(a) for a in all_a)) if all_a else None
def extract_client(text):
    tl=text.lower()
    for anchor in CLIENT_ANCHORS:
        idx=tl.find(anchor)
        if idx!=-1:
            name=text[idx+len(anchor):idx+len(anchor)+80].strip().splitlines()[0].strip()
            if name and not is_label(name): return name
    return None
def extract_vat(text):
    m=RE_VAT.search(text)
    return m.group(1).replace(",",".") if m else None
