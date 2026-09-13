import logging
import re
from datetime import datetime

import openpyxl

from .base_parser import BaseParser, InvoiceParseResult, timbre_fiscal_for_year, detect_year_from_invoice

logger = logging.getLogger(__name__)

EXCEL_COL = {
    "ref": 3,          # D
    "qty": 4,          # E
    "desc": 5,         # F
    "tva_code": 12,    # M
    "unit_price": 13,  # N
    "montant": 14,     # O
}


def _normalize_text(value) -> str:
    return str(value or "").strip().lower()


def _row_text(row) -> str:
    if row is None:
        return ""
    return " | ".join(str(v).strip() for v in row if v is not None and str(v).strip())


def _detect_item_columns(rows: list[tuple]) -> tuple[dict, int] | None:
    for row_idx, row in enumerate(rows[:80]):
        if row is None:
            continue

        ref_col = qty_col = desc_col = pu_col = montant_col = None
        for col_idx, value in enumerate(row):
            text = _normalize_text(value)
            if not text:
                continue
            if "réf" in text or text == "ref" or text == "reference" or "référence" in text or text == "code":
                ref_col = col_idx
            elif "quant" in text or "qté" in text or "qte" in text or "nombre" in text or text == "qty":
                qty_col = col_idx
            elif "description" in text or "désignation" in text or "designation" in text or "libellé" in text or "libelle" in text or "article" in text or "produit" in text:
                desc_col = col_idx
            elif text in {"p.u.", "p.u", "pu"} or "prix unitaire" in text or "prix unit" in text:
                pu_col = col_idx
            elif "montant" in text or "total" in text and "ht" not in text and "ttc" not in text:
                montant_col = col_idx
            # Skip "code t.v.a." / "tva" columns — recognized but not used

        # Accept layouts with or without a description column
        has_numeric_cols = pu_col is not None or montant_col is not None
        has_qty = qty_col is not None

        if has_qty and has_numeric_cols and (desc_col is not None or ref_col is not None):
            cols = {
                "ref": ref_col if ref_col is not None else (desc_col if desc_col is not None else qty_col),
                "qty": qty_col,
                "desc": desc_col if desc_col is not None else (ref_col if ref_col is not None else qty_col),
                "unit_price": pu_col if pu_col is not None else montant_col,
                "montant": montant_col if montant_col is not None else pu_col,
            }
            return cols, row_idx + 1

    return None


def _find_value_after_label(rows: list[tuple], labels: list[str]) -> str | None:
    targets = [label.lower() for label in labels]
    for row in rows[:60]:
        if row is None:
            continue
        row_values = [str(v).strip() if v is not None else "" for v in row]
        for idx, value in enumerate(row_values):
            lower = value.lower().rstrip(":")
            if any(target == lower for target in targets):
                for right in range(idx + 1, min(len(row_values), idx + 5)):
                    candidate = row_values[right].strip()
                    if candidate:
                        return candidate
    return None


def _find_by_regex(rows: list[tuple], pattern: str) -> str | None:
    rx = re.compile(pattern, re.IGNORECASE)
    for row in rows[:90]:
        text = _row_text(row)
        if not text:
            continue
        match = rx.search(text)
        if match:
            return match.group(1).strip()
    return None


def _cell(rows, row_idx: int, col_idx: int):
    try:
        row = rows[row_idx]
        if row is None or col_idx >= len(row):
            return None
        return row[col_idx]
    except (IndexError, TypeError):
        return None


def _to_float(value):
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _to_iso_date(value):
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, str):
        value = value.strip()
        for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%Y/%m/%d"):
            try:
                return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    return None


def _detect_company(path: str) -> str:
    p = str(path).upper()
    if "GAMESTREAM" in p or "ATLAS" in p:
        return "GameStream ATLAS"
    return "Acrobate Solution"


def _detect_doc_type(path: str) -> str:
    """Detect document type from file path and filename."""
    p = str(path).upper().replace("\\", "/")
    filename_only = p.rsplit("/", 1)[-1] if "/" in p else p

    # 1. Path folder structure (most reliable)
    if any(k in p for k in ("BON DE LIVRAISON", "BON DE LIV", "/BL/")):
        return "bon_de_livraison"
    if any(k in p for k in ("/DEVIS/", "/DEVIS ", "DEVIS/")):
        return "devis"
    if any(k in p for k in ("/FACTURE/", "/FACTURES/", "/FACTURE ", "FACTURE/")):
        return "facture"

    # 2. Filename keywords
    if re.search(r'\b(BON\s*DE\s*LIVRAISON|BON\s*DE\s*LIV)\b', filename_only):
        return "bon_de_livraison"
    if filename_only.startswith("BL ") or " BL " in filename_only:
        return "bon_de_livraison"
    if re.search(r'\bDEVIS\b|OFFRE\s*DE\s*PRIX', filename_only):
        return "devis"
    if re.search(r'\bFACTURE\b', filename_only):
        return "facture"

    return "unknown"

class ExcelParser(BaseParser):
    def can_parse(self, file_path: str) -> bool:
        return file_path.lower().endswith((".xlsx", ".xls"))

    def parse(self, file_path: str) -> InvoiceParseResult:
        result = InvoiceParseResult()
        result.source_file = file_path
        result.parser_name = "excel_coordinate_parser"

        try:
            wb = openpyxl.load_workbook(file_path, data_only=True)
        except Exception as exc:
            logger.error(f"Cannot open workbook {file_path}: {exc}")
            result.confidence = 0.0
            return result

        ws = wb.active
        rows = list(ws.iter_rows(min_row=1, values_only=True))

        invoice_no = _cell(rows, 1, 13)  # row 2, col N (template default)
        client_name = _cell(rows, 2, 4)  # row 3, col E (template default)
        invoice_date = _cell(rows, 2, 14)  # row 3, col O (template default)
        address = _cell(rows, 3, 4)  # row 4, col E
        order_no = _cell(rows, 3, 13)  # row 4, col O
        city = _cell(rows, 4, 5)  # row 5, col F
        country = _cell(rows, 4, 9)  # row 5, col J
        responsable = _cell(rows, 4, 13)  # row 5, col O
        mf = _cell(rows, 5, 13)  # row 6, col O
        phone = _cell(rows, 5, 4)  # row 6, col E

        invoice_no = invoice_no or _find_by_regex(rows, r"((?:FACTURE|DEVIS|OFFRE\s*DE\s*PRIX)\s*N[°o]?\s*[0-9]{4}[-/][0-9]+)")
        invoice_no = invoice_no or _find_by_regex(rows, r"((?:FACTURE|DEVIS|OFFRE\s*DE\s*PRIX)\s+[0-9]{4}[-/][0-9]+)")
        invoice_no = invoice_no or _find_by_regex(rows, r"N[°o]\s*(\d{3,}(?:[-/]\d+)?)")
        invoice_date = invoice_date or _find_by_regex(rows, r"Date\s*:?\s*(\d{2}/\d{2}/\d{4})")
        client_name = client_name or _find_value_after_label(rows, ["nom", "client", "destinataire", "société", "societe"])
        address = address or _find_value_after_label(rows, ["adresse"])
        city = city or _find_value_after_label(rows, ["ville"])
        country = country or _find_value_after_label(rows, ["pays"])
        responsable = responsable or _find_by_regex(rows, r"Responsable\s*:?\s*([^|]+)")
        mf = mf or _find_by_regex(rows, r"MF\s*:\s*([0-9]+\s+[0-9]+\s+[A-Z]+\s+[0-9]+)")
        phone = phone or _find_value_after_label(rows, ["téléphone", "telephone", "tél", "tel"])
        order_no = order_no or _find_by_regex(rows, r"(?:Réf|Ref)\s*commande\s*:?\s*([^|]+)")
        order_no = order_no or _find_by_regex(rows, r"Consultation\s*:?\s*(\S[^|]*)")

        if isinstance(invoice_no, str):
            # Normalize: keep DEVIS/FACTURE prefix in the invoice number
            inv_match = re.search(r'((?:FACTURE|DEVIS|OFFRE\s*DE\s*PRIX)\s*N[°o]?\s*\S+)', str(invoice_no), re.IGNORECASE)
            if not inv_match:
                # Try without N° — e.g. "FACTURE  2025-034"
                inv_match = re.search(r'((?:FACTURE|DEVIS|OFFRE\s*DE\s*PRIX)\s+[0-9]{4}[-/][0-9]+)', str(invoice_no), re.IGNORECASE)
            if inv_match:
                invoice_no = re.sub(r'\s+', '', inv_match.group(1)).replace('°', '')
            else:
                # Prefix with doc type from filename/path
                doc_prefix = ""
                fname_upper = (file_path or "").upper()
                if re.search(r'\bDEVIS\b', fname_upper):
                    doc_prefix = "DEVISN"
                elif re.search(r'\bFACTURE\b', fname_upper):
                    doc_prefix = "FACTUREN"
                raw_no = str(invoice_no).strip()
                # Remove standalone FACTURE/OFFRE prefix if leftover
                raw_no = re.sub(r"^(?:FACTURE|OFFRE\s+DE\s+PRIX)\s*", "", raw_no, flags=re.IGNORECASE).strip()
                invoice_no = f"{doc_prefix}{raw_no}" if doc_prefix and raw_no else raw_no

        items: list[dict] = []
        seen = set()
        column_detection = _detect_item_columns(rows)
        active_cols = EXCEL_COL
        item_start_row = 8  # 0-indexed => row 9 default
        if column_detection is not None:
            active_cols, item_start_row = column_detection

        for row in rows[item_start_row:]:
            if row is None or all(v is None for v in row):
                continue

            ref = row[active_cols["ref"]] if len(row) > active_cols["ref"] else None
            qty = row[active_cols["qty"]] if len(row) > active_cols["qty"] else None
            desc = row[active_cols["desc"]] if len(row) > active_cols["desc"] else None
            unit_price = row[active_cols["unit_price"]] if len(row) > active_cols["unit_price"] else None
            montant = row[active_cols["montant"]] if len(row) > active_cols["montant"] else None

            if (isinstance(unit_price, str) and "total" in unit_price.lower()) or (isinstance(desc, str) and desc.strip() in {"Comptant", "Chèque", "Virement"}):
                break

            if not isinstance(qty, (int, float)):
                continue

            # ref can be None for templates without a reference column
            ref_str = str(ref).strip() if ref is not None else ""
            if not ref_str:
                # Generate ref from description or item index
                desc_str = str(desc).strip() if desc else ""
                ref_str = re.sub(r'[^A-Za-z0-9]+', '-', desc_str.upper()).strip('-')[:24] or f"ITEM-{len(items) + 1}"

            if not isinstance(unit_price, (int, float)):
                continue

            desc_str = str(desc).strip() if desc else ""
            key = (ref_str, desc_str, qty, unit_price)
            if key in seen:
                continue
            seen.add(key)

            amount = _to_float(montant)
            if amount is None:
                amount = round(float(qty) * float(unit_price), 3)

            items.append(
                {
                    "ref": ref_str,
                    "description": desc_str,
                    "qty": int(qty) if float(qty).is_integer() else float(qty),
                    "unitPrice": round(float(unit_price), 3),
                    "amount": round(float(amount), 3),
                    "currency": "TND",
                }
            )

        total_ht = round(sum(item["amount"] for item in items), 3)

        # Try to extract actual totals by scanning for label cells and reading adjacent values
        def _find_labeled_amount(rows_list, labels):
            """Find a numeric value in the cell next to (or nearby) a label cell."""
            targets = [lbl.lower() for lbl in labels]
            for row in rows_list:
                if row is None:
                    continue
                for col_idx, cell_val in enumerate(row):
                    if cell_val is None:
                        continue
                    cell_text = str(cell_val).strip().lower().rstrip(":")
                    if any(t in cell_text for t in targets):
                        # Check next cells to the right for a numeric value
                        for right in range(col_idx + 1, min(len(row), col_idx + 4)):
                            v = row[right]
                            if isinstance(v, (int, float)):
                                return float(v)
                            if v is not None:
                                try:
                                    cleaned = str(v).replace(" ", "").replace(",", ".")
                                    return float(cleaned)
                                except (ValueError, TypeError):
                                    pass
            return None

        extracted_total_ht = _find_labeled_amount(rows, ["total h.t", "total ht"])
        extracted_tva = _find_labeled_amount(rows, ["t.v.a", "tva"])
        extracted_ttc = _find_labeled_amount(rows, ["total t.t.c", "total ttc"])
        extracted_timbre = _find_labeled_amount(rows, ["timbre fiscal", "timbre"])

        # Smart TVA extraction: find the row between Total HT and Total TTC
        # that has a TVA rate indicator (0.xx value, "xx%" text, or "TVA" label)
        extracted_tva_rate = None
        ht_row_idx = None
        ttc_row_idx = None
        for row_idx, row in enumerate(rows):
            if row is None:
                continue
            for cell_val in row:
                if cell_val is None:
                    continue
                cell_text = str(cell_val).strip().lower().rstrip(":")
                if "total h" in cell_text:
                    ht_row_idx = row_idx
                elif "total t" in cell_text:
                    ttc_row_idx = row_idx

        if extracted_tva is None and ht_row_idx is not None and ttc_row_idx is not None:
            # Scan rows between HT and TTC for a row with a TVA rate indicator
            for row_idx in range(ht_row_idx + 1, ttc_row_idx):
                row = rows[row_idx] if row_idx < len(rows) else None
                if row is None:
                    continue
                # Skip rows that are clearly not TVA (remise, avance, etc.)
                row_text = " ".join(str(v).strip().lower() for v in row if v is not None)
                if any(skip in row_text for skip in ["remise", "avance", "retenue", "mt apres", "acompte"]):
                    continue
                # Look for a TVA rate indicator + amount
                rate_val = None
                amount_val = None
                has_tva_label = "tva" in row_text or "t.v.a" in row_text
                for col_idx, cell_val in enumerate(row):
                    if cell_val is None:
                        continue
                    if isinstance(cell_val, (int, float)):
                        fval = float(cell_val)
                        if 0 < fval < 1:
                            # Likely a TVA rate (e.g. 0.19)
                            rate_val = fval
                        elif fval > 1:
                            amount_val = fval
                    elif isinstance(cell_val, str):
                        # Check for "19%" or "19,00%" or "TVA19%"
                        rate_match = re.search(r'(\d{1,2}(?:[,.]\d{1,2})?)%', cell_val.strip())
                        if rate_match:
                            rate_val = float(rate_match.group(1).replace(',', '.')) / 100.0
                # Only accept this row as TVA if it has a rate indicator or TVA label
                if amount_val is not None and (rate_val is not None or has_tva_label):
                    extracted_tva = amount_val
                    if rate_val is not None:
                        extracted_tva_rate = rate_val
                    break  # Found TVA row, stop searching

        def _parse_extracted(val):
            if val is None:
                return None
            cleaned = str(val).replace(" ", "").replace(",", ".")
            try:
                return float(cleaned)
            except (ValueError, TypeError):
                return None

        actual_ht = _parse_extracted(extracted_total_ht)
        actual_tva = _parse_extracted(extracted_tva)
        actual_ttc = _parse_extracted(extracted_ttc)
        actual_timbre = _parse_extracted(extracted_timbre)

        # Use extracted values if available, otherwise compute
        if actual_ht and actual_ht > 0:
            total_ht = round(actual_ht, 3)

        # If TTC == HT exactly, no TVA and no timbre were applied
        if actual_ttc and actual_ht and abs(actual_ttc - actual_ht) < 0.01:
            timbre_fiscal = 0.0
            tva = 0.0
            tva_rate = 0.0
            total_ttc = round(actual_ttc, 3)
        else:
            # Determine invoice year for correct timbre fiscal default
            _inv_year = detect_year_from_invoice(
                str(invoice_no) if invoice_no else None,
                _to_iso_date(invoice_date),
                file_path
            )
            default_timbre = timbre_fiscal_for_year(_inv_year)

            # Timbre fiscal: use extracted or year-aware default
            if actual_timbre is not None and actual_timbre > 0:
                timbre_fiscal = round(actual_timbre, 3)
            else:
                timbre_label_found = any(
                    any("timbre" in str(v).lower() for v in row if v is not None)
                    for row in rows if row is not None
                )
                if timbre_label_found:
                    timbre_fiscal = round(actual_timbre, 3) if actual_timbre and actual_timbre > 0 else default_timbre
                else:
                    timbre_fiscal = default_timbre

            # ── Guard: detect TVA/timbre confusion ──
            # If extracted TVA equals a known timbre value and is suspiciously small
            # relative to Total HT, it's likely the parser grabbed timbre instead of TVA.
            KNOWN_TIMBRE_VALUES = {0.5, 0.6, 0.600, 0.7, 1.0}
            if actual_tva and total_ht > 0:
                if actual_tva in KNOWN_TIMBRE_VALUES or abs(actual_tva - timbre_fiscal) < 0.01:
                    expected_min_tva = total_ht * 0.05  # TVA should be at least 5% of HT
                    if actual_tva < expected_min_tva:
                        logger.warning(
                            f"TVA/timbre confusion detected: extracted TVA={actual_tva:.3f} "
                            f"matches timbre value, HT={total_ht:.3f}. Discarding extracted TVA."
                        )
                        actual_tva = None  # force recalculation from TTC formula

            # ── TVA determination: cross-validate extracted vs computed ──
            # When we have TTC + HT + timbre, the FORMULA is the ground truth:
            #   TVA = TTC - HT - timbre
            # We trust the formula over a raw label extraction which can
            # pick up the wrong cell (e.g. timbre value next to TVA label).
            computed_tva = None
            if actual_ttc and actual_ttc > 0 and total_ht > 0:
                computed_tva = round(actual_ttc - total_ht - timbre_fiscal, 3)
                if computed_tva < 0:
                    computed_tva = 0.0

            if actual_tva and actual_tva > 0 and computed_tva is not None:
                # Cross-validate: if extracted TVA is wildly off from formula, use formula
                tva_deviation = abs(actual_tva - computed_tva)
                tolerance = max(1.0, total_ht * 0.01)
                if tva_deviation > tolerance:
                    logger.warning(
                        f"TVA cross-validation: extracted={actual_tva:.3f} vs computed={computed_tva:.3f} "
                        f"(TTC={actual_ttc:.3f} - HT={total_ht:.3f} - timbre={timbre_fiscal:.3f}). "
                        f"Using computed value."
                    )
                    tva = computed_tva
                else:
                    tva = round(actual_tva, 3)
            elif computed_tva is not None and computed_tva >= 0:
                tva = computed_tva
            elif actual_tva and actual_tva > 0:
                tva = round(actual_tva, 3)
            else:
                tva = round(total_ht * 0.19, 3)

            # Determine TVA rate: prefer computed from amount over extracted label
            if tva > 0 and total_ht > 0:
                computed_rate = round(tva / total_ht, 4)
                # Snap to standard Tunisian rates (7%, 13%, 19%) if close
                for std_rate in (0.07, 0.13, 0.19):
                    if abs(computed_rate - std_rate) < 0.005:
                        computed_rate = std_rate
                        break
                tva_rate = computed_rate
            elif extracted_tva_rate and extracted_tva_rate > 0:
                tva_rate = round(extracted_tva_rate, 4)
            elif tva == 0:
                tva_rate = 0.0
            else:
                tva_rate = 0.19

            total_ttc = round(actual_ttc, 3) if actual_ttc and actual_ttc > 0 else round(total_ht + tva + timbre_fiscal, 3)

        # --- Validate totals ---
        validation_warnings = []
        if total_ht > 0 and tva_rate > 0:
            expected_tva = round(total_ht * tva_rate, 3)
            tva_diff = abs(tva - expected_tva)
            if tva_diff > max(1.0, total_ht * 0.005):
                validation_warnings.append(f"tva-mismatch:extracted={tva:.3f}|expected={expected_tva:.3f}|rate={tva_rate}")

        if total_ht > 0 and total_ttc > 0:
            expected_ttc = round(total_ht + tva + timbre_fiscal, 3)
            ttc_diff = abs(total_ttc - expected_ttc)
            if ttc_diff > max(1.0, total_ttc * 0.005):
                validation_warnings.append(f"ttc-mismatch:extracted={total_ttc:.3f}|expected={expected_ttc:.3f}")

        if items:
            items_total = round(sum(item["amount"] for item in items), 3)
            if items_total > 0 and total_ht > 0:
                ht_diff = abs(items_total - total_ht)
                if ht_diff > max(1.0, total_ht * 0.02):
                    validation_warnings.append(f"items-vs-ht:items={items_total:.3f}|ht={total_ht:.3f}")

        result.invoice_no = str(invoice_no).strip() if invoice_no else None
        result.date = _to_iso_date(invoice_date)
        result.client_name = str(client_name).strip() if client_name else None
        result.client_address = str(address).strip() if address else None
        result.country = str(country).strip() if country else "TN"
        result.responsable = str(responsable).strip() if responsable else None
        result.commande_no = str(order_no).strip() if order_no else None
        result.consultation_ref = result.commande_no
        result.mf_field = str(mf).strip() if mf else None
        result.extra["client_phone"] = str(phone).strip() if phone else None
        result.extra["client_city"] = str(city).strip() if city else None
        result.total_ht = total_ht
        result.tva_rate = tva_rate
        result.tva_amount = tva
        result.timbre_fiscal = timbre_fiscal
        result.total_ttc = total_ttc
        result.line_items = items
        result.extra["extraction_method"] = "coordinate"
        result.extra["company"] = _detect_company(file_path)
        if validation_warnings:
            result.extra["total_validation_warnings"] = validation_warnings
            logger.warning(f"Total validation warnings for {file_path}: {validation_warnings}")
        else:
            result.extra["totals_validated"] = True
        # Detect document type from filename/path
        result.document_type = _detect_doc_type(file_path)
        result.confidence = 0.97 if result.invoice_no and items else 0.65

        result.raw_text = "\n".join(
            str(v)
            for v in [
                result.invoice_no,
                result.date,
                result.client_name,
                result.client_address,
                result.commande_no,
                result.total_ttc,
            ]
            if v is not None
        )

        # Extract additional metadata from rows
        amount_in_words = _find_value_after_label(rows, ["arrêté", "arrete", "montant en lettres", "somme de"])
        if amount_in_words:
            result.amount_in_words = str(amount_in_words).strip()

        rib_value = _find_value_after_label(rows, ["rib", "r.i.b"])
        if rib_value:
            result.rib = str(rib_value).strip()

        bank_value = _find_value_after_label(rows, ["banque", "bank"])
        if bank_value:
            result.bank = str(bank_value).strip()

        payment_value = _find_value_after_label(rows, ["mode de paiement", "règlement", "reglement"])
        if payment_value:
            result.payment_method = str(payment_value).strip()

        seller_email = _find_by_regex(rows, r"(?:Email|E-mail|Mail)\s*:?\s*([\w.+-]+@[\w.-]+)")
        if seller_email:
            result.seller_email = seller_email

        seller_website = _find_by_regex(rows, r"(?:Web|Site|www)\s*:?\s*((?:www\.)?[\w.-]+\.[\w]{2,})")
        if seller_website:
            result.seller_website = seller_website

        return result
