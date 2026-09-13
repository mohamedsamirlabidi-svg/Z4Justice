import pdfplumber
import re
import os
from datetime import datetime

PATTERNS = {
    "invoice_no": r"FACTURE\s+N[°o]\s*(\S+)",
    "date": r"(\d{2}/\d{2}/\d{4})",
    "client_name": r"Nom\s*:?\s+([A-Za-z0-9À-ÿ\s&.]+?)(?:\s{2,}|Date|$)",
    "address": r"Adresse\s*:?\s+(.+?)(?:\s{2,}|Responsable|MF|$)",
    "responsable": r"Responsable\s*:?\s+(.+?)(?:\s{2,}|MF|$)",
    "mf": r"MF\s*:?\s+(\S+)",
    "total_ht": r"Total\s+H\.T\.\s+([\d\s,\.]+)\s*DT",
    "timbre": r"TIMBRE\s+FISCAL\s+([\d,\.]+)\s*DT",
    "tva_amount": r"19[,.]00%\s+([\d\s,\.]+)\s*DT",
    "total_ttc": r"Total\s+T\.T\.C\.\s+([\d\s,\.]+)\s*DT",
}


def extract_pdf(path):
    """Parse an Acrobat Solutions PDF invoice using pdfplumber + regex."""
    with pdfplumber.open(path) as pdf:
        full_text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    # --- Extract header fields via regex ---
    invoice_no = _regex_first(PATTERNS["invoice_no"], full_text)
    date_str = _regex_first(PATTERNS["date"], full_text)
    if date_str:
        try:
            date_str = datetime.strptime(date_str, "%d/%m/%Y").strftime("%Y-%m-%d")
        except ValueError:
            pass

    client_name = _extract_client_name(full_text)
    address = _regex_first(PATTERNS["address"], full_text)
    responsable = _regex_first(PATTERNS["responsable"], full_text)
    mf = _regex_first(PATTERNS["mf"], full_text)

    # --- Extract line items from tables ---
    items = []
    seen = set()
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                if not table:
                    continue
                for row in table:
                    if not row or len(row) < 3:
                        continue
                    parsed_item = _try_parse_table_row(row, col_map=_detect_pdf_table_columns(table))
                    if parsed_item is None:
                        continue

                    key = (parsed_item["ref"], parsed_item["description"],
                           parsed_item["qty"], parsed_item["unitPrice"])
                    if key in seen:
                        continue
                    seen.add(key)
                    items.append(parsed_item)

    # Fallback: try regex on text lines if no table items found
    if not items:
        items = _extract_items_from_text(full_text, seen)

    # --- Extract totals via regex ---
    total_ht = _parse_amount(PATTERNS["total_ht"], full_text)
    timbre = _parse_amount(PATTERNS["timbre"], full_text)
    total_ttc = _parse_amount(PATTERNS["total_ttc"], full_text)

    # ── TVA extraction: try multiple patterns ──
    tva = _parse_amount(PATTERNS["tva_amount"], full_text)
    tva_rate_extracted = None

    # Try labeled format: "T.V.A 19% 722,000" or "T.V.A. 19,00% 663,480 DT"
    if tva is None:
        tva_labeled_match = re.search(
            r"T\.?V\.?A\.?\s*(\d{1,2}(?:[,.]\d{1,2})?)%\s+([\d\s,.]+)\s*(?:DT|TND)?",
            full_text, re.IGNORECASE
        )
        if tva_labeled_match:
            tva_rate_extracted = _amount_str_to_float(tva_labeled_match.group(1))
            tva = _amount_str_to_float(tva_labeled_match.group(2))

    # Try standalone format: "19,00% 663,480 DT" (Acrobate invoices)
    if tva is None:
        tva_standalone_match = re.search(
            r"(?:^|\n)[^\n]*?(\d{1,2}[,.]\d{2})%\s+([\d\s,.]+)\s*DT",
            full_text
        )
        if tva_standalone_match:
            tva_rate_extracted = _amount_str_to_float(tva_standalone_match.group(1))
            tva = _amount_str_to_float(tva_standalone_match.group(2))

    # Fallback: compute if extraction missed
    if total_ht is None and items:
        total_ht = round(sum(i["amount"] for i in items), 3)
    elif total_ht is None:
        total_ht = 0.0

    from app.parsers.base_parser import timbre_fiscal_for_year, detect_year_from_invoice
    _inv_year = detect_year_from_invoice(invoice_no, date_str, str(path))
    default_timbre = timbre_fiscal_for_year(_inv_year)

    if timbre is None:
        timbre = default_timbre

    # ── Guard: detect TVA/timbre confusion ──
    KNOWN_TIMBRE_VALUES = {0.5, 0.6, 0.600, 0.7, 1.0}
    if tva and total_ht > 0:
        if tva in KNOWN_TIMBRE_VALUES or abs(tva - timbre) < 0.01:
            expected_min_tva = total_ht * 0.05
            if tva < expected_min_tva:
                tva = None  # force recalculation

    # ── TVA cross-validation: TTC formula is ground truth ──
    computed_tva = None
    if total_ttc and total_ttc > 0 and total_ht > 0:
        computed_tva = round(total_ttc - total_ht - timbre, 3)
        if computed_tva < 0:
            computed_tva = 0.0

    if tva and tva > 0 and computed_tva is not None:
        tva_deviation = abs(tva - computed_tva)
        tolerance = max(1.0, total_ht * 0.01)
        if tva_deviation > tolerance:
            tva = computed_tva
    elif computed_tva is not None and computed_tva >= 0:
        tva = computed_tva
    elif tva is None:
        tva = round(total_ht * 0.19, 3)

    # ── Determine TVA rate from corrected TVA amount ──
    tax_rate = 0.19  # default
    if tva and tva > 0 and total_ht > 0:
        computed_rate = round(tva / total_ht, 4)
        # Snap to standard Tunisian rates (7%, 13%, 19%) if close
        for std_rate in (0.07, 0.13, 0.19):
            if abs(computed_rate - std_rate) < 0.005:
                computed_rate = std_rate
                break
        tax_rate = computed_rate
    elif tva_rate_extracted and tva_rate_extracted > 0:
        tax_rate = round(tva_rate_extracted / 100.0, 4) if tva_rate_extracted > 1 else round(tva_rate_extracted, 4)
    elif tva == 0:
        tax_rate = 0.0

    if total_ttc is None:
        total_ttc = round(total_ht + tva + timbre, 3)

    company = _detect_company(path)

    return {
        "invoiceNo": invoice_no,
        "date": date_str,
        "status": "pending",
        "currency": "TND",
        "company": company,
        "totalAmount": total_ttc,
        "totalHT": total_ht,
        "taxAmount": tva,
        "taxRate": tax_rate,
        "timbreFiscal": timbre,
        "client": {
            "name": client_name,
            "address": address,
            "taxId": mf,
            "contactName": responsable,
        },
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
        "sourceFile": os.path.basename(path),
        "notes": f"Parsed by flask-parser v2 | items: {len(items)} | confidence: {'high' if items else 'low'}",
        "_raw_text": full_text,
    }


def _extract_client_name(text):
    """Extract client name from text after 'Nom:' label."""
    for line in text.split("\n"):
        if "Nom" in line and (":" in line or "Nom " in line):
            # Try splitting on "Nom:" or "Nom "
            for sep in ["Nom:", "Nom "]:
                if sep in line:
                    parts = line.split(sep, 1)
                    if len(parts) > 1:
                        name = parts[1].strip()
                        # Cut off at next label (Date, Commande, etc.)
                        for delimiter in ["Date", "Commande", "Tel", "MF", "Code postal"]:
                            if delimiter in name:
                                name = name.split(delimiter)[0].strip()
                        if name and len(name) > 1:
                            return name
    return None


def _detect_pdf_table_columns(table):
    """Detect column layout from a PDF table header row."""
    for row in table[:5]:
        if not row or len(row) < 3:
            continue
        cells = [str(c or "").strip().lower() for c in row]
        merged = " ".join(cells)
        header_kws = ["réf", "ref", "quant", "qté", "p.u", "montant", "désignation", "description"]
        if sum(1 for kw in header_kws if kw in merged) < 2:
            continue
        col_map = {}
        for idx, t in enumerate(cells):
            if not t:
                continue
            if "réf" in t or t == "ref":
                col_map["ref"] = idx
            elif "quant" in t or "qté" in t or "qte" in t:
                col_map["qty"] = idx
            elif "désignation" in t or "description" in t:
                col_map["desc"] = idx
            elif "p.u" in t or t == "pu" or "prix unitaire" in t:
                col_map["pu"] = idx
            elif "montant" in t:
                col_map["montant"] = idx
        if "qty" in col_map and ("ref" in col_map or "montant" in col_map):
            return col_map
    return None


def _try_parse_table_row(row, col_map=None):
    """Try to parse a table row as a line item. Returns dict or None."""
    if not row or len(row) < 3:
        return None

    # Handle rows with newline-separated values
    cells = []
    for cell in row:
        if cell is None:
            cells.append("")
        else:
            cells.append(str(cell).strip())

    # Skip rows that are clearly headers or totals
    combined = " ".join(cells).lower()
    skip_keywords = ["total", "timbre", "tva", "t.v.a", "référence", "quantité",
                     "description", "montant", "p.u", "signature", "cachet",
                     "virement", "chèque", "comptant", "conforme", "arrete",
                     "code t.v.a"]
    if any(kw in combined for kw in skip_keywords):
        return None

    # ── Use detected column layout if available ──
    if col_map and "ref" in col_map and "qty" in col_map:
        ref_idx = col_map["ref"]
        qty_idx = col_map["qty"]
        desc_idx = col_map.get("desc")
        pu_idx = col_map.get("pu")
        montant_idx = col_map.get("montant")

        ref = cells[ref_idx] if ref_idx < len(cells) else ""
        qty_str = cells[qty_idx] if qty_idx < len(cells) else ""
        desc = cells[desc_idx] if desc_idx is not None and desc_idx < len(cells) else ""
        if not ref or not qty_str:
            return None
        try:
            qty = int(float(qty_str))
        except (ValueError, TypeError):
            return None
        if qty <= 0:
            return None

        unit_price = None
        montant = None
        if pu_idx is not None and pu_idx < len(cells):
            unit_price = _clean_amount(cells[pu_idx])
        if montant_idx is not None and montant_idx < len(cells):
            montant = _clean_amount(cells[montant_idx])

        # Fallback: scan non-mapped cells for numeric values
        if unit_price is None or montant is None:
            skip = {ref_idx, qty_idx}
            if desc_idx is not None:
                skip.add(desc_idx)
            nums = []
            for ci, c in enumerate(cells):
                if ci in skip:
                    continue
                v = _clean_amount(c)
                if v is not None and v > 0:
                    nums.append(v)
            if unit_price is None and len(nums) >= 1:
                unit_price = nums[0]
            if montant is None and len(nums) >= 2:
                montant = nums[1]

        if unit_price is None and montant is not None:
            unit_price = montant / qty if qty > 0 else montant
        if montant is None and unit_price is not None:
            montant = unit_price * qty
        if unit_price is None or montant is None:
            return None

        if not desc:
            desc = ref

        return {
            "ref": ref,
            "description": desc,
            "qty": qty,
            "unitPrice": round(unit_price, 3),
            "amount": round(montant, 3),
        }

    # ── Default: positional parsing ──

    # Try to identify: ref, qty, desc, unit_price, montant
    # Common table structures: [ref, qty, desc, pu, montant] or [ref, qty, desc, tva, pu, montant]
    ref = cells[0] if len(cells) > 0 else ""
    qty_str = cells[1] if len(cells) > 1 else ""
    desc = cells[2] if len(cells) > 2 else ""

    if not ref or not qty_str:
        return None

    try:
        qty = int(qty_str)
    except ValueError:
        try:
            qty = int(float(qty_str))
        except (ValueError, TypeError):
            return None

    if qty <= 0:
        return None

    # Find unit_price and montant - they could be in different positions
    unit_price = None
    montant = None

    # Try positions from the end
    for i in range(len(cells) - 1, 2, -1):
        val = _clean_amount(cells[i])
        if val is not None and val > 0:
            if montant is None:
                montant = val
            elif unit_price is None:
                unit_price = val
                break

    if unit_price is None and montant is not None:
        unit_price = montant / qty if qty > 0 else montant
    if montant is None and unit_price is not None:
        montant = unit_price * qty

    if unit_price is None or montant is None:
        return None

    return {
        "ref": ref,
        "description": desc,
        "qty": qty,
        "unitPrice": round(unit_price, 3),
        "amount": round(montant, 3),
    }


def _extract_items_from_text(text, seen):
    """Fallback: extract line items from plain text using regex."""
    items = []
    # Pattern: ref(alphanumeric) qty(int) description unit_price DT montant DT
    line_pattern = re.compile(
        r'^(\w{3,10})\s+(\d+)\s+(.+?)\s+([\d\s,]+[.,]\d+)\s*DT\s+([\d\s,]+[.,]\d+)\s*DT',
        re.MULTILINE
    )
    for m in line_pattern.finditer(text):
        ref = m.group(1).strip()
        qty = int(m.group(2))
        desc = m.group(3).strip()
        unit_price = _amount_str_to_float(m.group(4))
        montant = _amount_str_to_float(m.group(5))

        if unit_price is None or montant is None:
            continue

        key = (ref, desc, qty, unit_price)
        if key in seen:
            continue
        seen.add(key)

        items.append({
            "ref": ref,
            "description": desc,
            "qty": qty,
            "unitPrice": round(unit_price, 3),
            "amount": round(montant, 3),
        })
    return items


def _regex_first(pattern, text):
    """Return first capturing group of regex match, or None."""
    m = re.search(pattern, text, re.IGNORECASE)
    return m.group(1).strip() if m else None


def _parse_amount(pattern, text):
    """Extract a monetary amount from regex match."""
    m = re.search(pattern, text, re.IGNORECASE)
    if m:
        return _amount_str_to_float(m.group(1))
    return None


def _amount_str_to_float(s):
    """Convert a French-formatted amount string to float."""
    if not s:
        return None
    s = s.strip().replace(" ", "").replace("\xa0", "")
    s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _clean_amount(s):
    """Try to parse a cell value as a monetary amount."""
    if not s:
        return None
    s = s.replace("DT", "").replace("dt", "").strip()
    return _amount_str_to_float(s)


def _detect_company(path):
    """Detect company from file path."""
    p = str(path).upper()
    if "ACROBATE" in p or "ACROBAT" in p:
        return "Acrobate Solution"
    if "GAMESTREAM" in p or "ATLAS" in p:
        return "GameStream ATLAS"
    return "Acrobate Solution"
