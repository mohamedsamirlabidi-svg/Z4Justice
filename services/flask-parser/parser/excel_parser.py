import openpyxl
import re
from datetime import datetime
from app.parsers.base_parser import timbre_fiscal_for_year, detect_year_from_invoice

# Fixed column indices (0-based) for the Acrobat Solutions Excel template
EXCEL_COL = {
    "ref": 3,          # D
    "qty": 4,          # E
    "desc": 5,         # F
    "tva_code": 12,    # M
    "unit_price": 13,  # N
    "montant": 14,     # O
}


def extract_excel(path):
    """Parse an Acrobat Solutions Excel invoice using coordinate-based extraction."""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(min_row=1, values_only=True))

    # --- Header fields (fixed coordinates, 0-indexed rows) ---
    invoice_no = _cell(rows, 1, 13)    # row 2, col N
    client_name = _cell(rows, 2, 4)    # row 3, col E
    invoice_date = _cell(rows, 2, 14)  # row 3, col O
    address = _cell(rows, 3, 4)        # row 4, col E
    order_no = _cell(rows, 3, 13)      # row 4, col O (order number)
    city = _cell(rows, 4, 5)           # row 5, col F
    country = _cell(rows, 4, 9)        # row 5, col J
    responsable = _cell(rows, 4, 13)   # row 5, col O
    mf = _cell(rows, 5, 13)           # row 6, col O
    phone = _cell(rows, 5, 4)         # row 6, col E

    # Clean invoice_no: strip "FACTURE " prefix
    if invoice_no and isinstance(invoice_no, str):
        invoice_no = invoice_no.replace("FACTURE ", "").strip()

    # Normalize date
    if isinstance(invoice_date, datetime):
        invoice_date = invoice_date.strftime("%Y-%m-%d")
    elif invoice_date:
        invoice_date = _normalize_date_str(str(invoice_date))

    # --- Line items: scan from row 9 onward (0-indexed = 8) ---
    items = []
    seen = set()
    ITEM_START_ROW = 8

    for i in range(ITEM_START_ROW, len(rows)):
        row = rows[i]
        if row is None or all(v is None for v in row):
            continue

        ref = row[EXCEL_COL["ref"]] if len(row) > EXCEL_COL["ref"] else None
        qty = row[EXCEL_COL["qty"]] if len(row) > EXCEL_COL["qty"] else None
        desc = row[EXCEL_COL["desc"]] if len(row) > EXCEL_COL["desc"] else None
        unit_price = row[EXCEL_COL["unit_price"]] if len(row) > EXCEL_COL["unit_price"] else None
        montant = row[EXCEL_COL["montant"]] if len(row) > EXCEL_COL["montant"] else None

        # Stop at totals section
        if isinstance(unit_price, str) and "Total" in unit_price:
            break
        if isinstance(desc, str) and desc.strip().lower() in ("comptant", "chèque", "virement"):
            break

        # Valid line item: must have ref (non-empty string) AND numeric qty
        if not ref or not isinstance(qty, (int, float)):
            continue
        if isinstance(ref, (int, float)):
            ref = str(int(ref)) if float(ref) == int(ref) else str(ref)
        ref = str(ref).strip()
        if ref == "":
            continue

        # Skip if unit_price is a label or None
        if not isinstance(unit_price, (int, float)):
            continue

        # Deduplication key
        desc_str = str(desc).strip() if desc else ""
        key = (ref, desc_str, qty, unit_price)
        if key in seen:
            continue
        seen.add(key)

        computed_amount = round(float(unit_price) * float(qty), 3)
        items.append({
            "ref": ref,
            "description": desc_str,
            "qty": int(qty) if float(qty) == int(float(qty)) else float(qty),
            "unitPrice": float(unit_price),
            "amount": float(montant) if isinstance(montant, (int, float)) else computed_amount,
            "currency": "TND",
        })

    # --- Compute totals ---
    total_ht = round(sum(item["amount"] for item in items), 3)
    _inv_year = detect_year_from_invoice(
        str(invoice_no).strip() if invoice_no else None,
        invoice_date,
        str(path)
    )
    timbre_fiscal = timbre_fiscal_for_year(_inv_year)
    tva = round(total_ht * 0.19, 3)
    total_ttc = round(total_ht + tva + timbre_fiscal, 3)

    # Detect company from path
    company = _detect_company(path)

    return {
        "invoiceNo": str(invoice_no).strip() if invoice_no else None,
        "date": invoice_date,
        "status": "pending",
        "currency": "TND",
        "company": company,
        "totalAmount": total_ttc,
        "totalHT": total_ht,
        "taxAmount": tva,
        "taxRate": 0.19,
        "timbreFiscal": timbre_fiscal,
        "client": {
            "name": str(client_name).strip() if client_name else None,
            "address": str(address).strip() if address else None,
            "city": str(city).strip() if city else None,
            "country": str(country).strip() if country else "TN",
            "phone": str(phone).strip() if phone else None,
            "taxId": str(mf).strip() if mf else None,
            "contactName": str(responsable).strip() if responsable else None,
        },
        "orderNo": str(order_no).strip() if order_no else None,
        "items": [
            {
                "description": item["description"],
                "quantity": item["qty"],
                "unitPrice": item["unitPrice"],
                "totalPrice": item["amount"],
                "productCode": item["ref"],
            }
            for item in items
        ],
        "sourceFile": _basename(path),
        "notes": f"Parsed by flask-parser v2 | items: {len(items)} | confidence: high",
    }


def _cell(rows, row_idx, col_idx):
    """Safely get a cell value from the rows list."""
    try:
        row = rows[row_idx]
        if row is None:
            return None
        if col_idx >= len(row):
            return None
        return row[col_idx]
    except (IndexError, TypeError):
        return None


def _normalize_date_str(raw):
    """Try to parse various date formats into YYYY-MM-DD."""
    if not raw:
        return None
    raw = raw.strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw


def _detect_company(path):
    """Detect company from file path."""
    p = str(path).upper()
    if "ACROBATE" in p or "ACROBAT" in p:
        return "Acrobate Solution"
    if "GAMESTREAM" in p or "ATLAS" in p:
        return "GameStream ATLAS"
    return "Acrobate Solution"


def _basename(path):
    """Get the filename from a path."""
    import os
    return os.path.basename(path)
