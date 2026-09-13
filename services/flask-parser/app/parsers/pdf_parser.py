import logging
import re
from datetime import datetime

import pdfplumber

from .base_parser import BaseParser, InvoiceParseResult, timbre_fiscal_for_year, detect_year_from_invoice

logger = logging.getLogger(__name__)

PATTERNS = {
    "invoice_no": r"((?:FACTURE|DEVIS|OFFRE\s*DE\s*PRIX)\s*N[°o]?\s*(?:[0-9]{4}[-/][0-9]+|\S+))",
    "invoice_no_simple": r"((?:FACTURE|DEVIS|OFFRE\s*DE\s*PRIX)\s+[0-9]{4}[-/][0-9]+)",
    "invoice_no_alt": r"N[°o]\s*(\d{3,}(?:[-/]\d+)?)",
    "date": r"(\d{2}/\d{2}/\d{4})",
    "address": r"Adresse\s*:?\s+(.+?)(?:\s{2,}|Responsable|MF|Consultation|Code\s*postal|$)",
    "responsable": r"Responsable\s*:?\s+(.+?)(?:\s{2,}|MF|$)",
    "mf": r"MF\s*:\s*([0-9]+\s+[0-9]+\s+[A-Z]+\s+[0-9]+)",
    "total_ht": r"Total\s+H\.?T\.?\s+([\d\s,.]+)\s*(?:DT|TND)?",
    "timbre": r"TIMBRE\s+FISCAL\s+([\d\s,.]+)\s*(?:DT|TND)?",
    "timbre_alt": r"Timbre\s+([\d,.]+)\s*(?:DT|TND)?",
    # GameStream format: "T.V.A 19% 722,000" or "T.V.A. 19,00% 663,480 DT"
    "tva_labeled": r"T\.?V\.?A\.?\s*(\d{1,2}(?:[,.]\d{1,2})?)%\s+([\d\s,.]+)\s*(?:DT|TND)?",
    # Acrobate format: standalone "19,00% 663,480 DT" (between Total HT and Total TTC lines)
    "tva_standalone": r"(?:^|\n)[^\n]*?(\d{1,2}[,.]\d{2})%\s+([\d\s,.]+)\s*DT",
    "total_ttc": r"Total\s+T\.?T\.?C\.?\s+([\d\s,.]+)\s*(?:DT|TND)?",
    # Additional extraction patterns
    "amount_in_words": r"(?:ARRETE\s+LA\s+PRESENTE\s+FACTURE\s+A\s+LA\s+SOMME\s+DE\s*:|Arr[eê]t[ée]\s+la\s+pr[ée]sente|Montant\s+en\s+lettres?)\s*[:.]?\s*(.+?)(?:\s+Total|\s*$)",
    "rib": r"(?:RIB|R\.I\.B\.?)\s*[:.]?\s*([0-9\s]{10,30})",
    "bank": r"(?:Banque|Bank)\s*[:.]?\s*([^\n\r|]+)",
    "payment_method": r"(?:Mode\s+de\s+paiement|R[eè]glement)\s*[:.]?\s*(Comptant|Ch[eè]que|Virement|Esp[eè]ces)",
    "seller_email": r"(?:Email|E-mail|Mail)\s*[:.]?\s*([\w.+-]+@[\w.-]+)",
    "seller_website": r"(?:Web|Site|www)\s*[:.]?\s*((?:www\.)?[\w.-]+\.[\w]{2,})",
    "phone": r"(?:T[ée]l(?:[ée]phone)?|Phone|Fax)\s*[:.]?\s*([0-9\s+().-]{7,20})",
}


def _value_pair_score(qty: int, unit_price: float, amount: float) -> tuple[float, float, float]:
    """Lower score is better for selecting (unit_price, amount)."""
    expected = float(qty) * float(unit_price)
    mismatch = abs(float(amount) - expected)
    relative = mismatch / max(expected, 1.0)
    inverted_penalty = 1.0 if qty > 1 and amount < unit_price else 0.0
    amount_tiebreak = -float(amount)
    return (relative, inverted_penalty, amount_tiebreak)

class PdfParser(BaseParser):
    def can_parse(self, file_path: str) -> bool:
        return file_path.lower().endswith(".pdf")

    def parse(self, file_path: str) -> InvoiceParseResult:
        result = InvoiceParseResult()
        result.source_file = file_path
        result.parser_name = "pdf_plumber_regex"

        text = self._extract_text(file_path)
        if not text or len(text) < 100:
            text = self._ocr_fallback(file_path)
            result.parser_name = "pdf_ocr_regex"

        result.raw_text = text

        raw_inv_no = self._regex_first(PATTERNS["invoice_no"], text)
        if not raw_inv_no:
            raw_inv_no = self._regex_first(PATTERNS["invoice_no_simple"], text)
        # Normalize: "DEVIS N° 2025-106" -> "DEVISN2025-106"
        result.invoice_no = re.sub(r'\s+', '', (raw_inv_no or '')).replace('°', '') or None

        # Fallback: try alt pattern (N°027, N°008, etc.) and prefix with doc type
        if not result.invoice_no:
            alt_no = self._regex_first(PATTERNS["invoice_no_alt"], text)
            if alt_no:
                # Detect doc type prefix from filename/path
                doc_prefix = ""
                fname_upper = (file_path or "").upper()
                if re.search(r'\bDEVIS\b', fname_upper):
                    doc_prefix = "DEVISN"
                elif re.search(r'\bFACTURE\b', fname_upper):
                    doc_prefix = "FACTUREN"
                result.invoice_no = f"{doc_prefix}{alt_no}"
        raw_date = self._regex_first(PATTERNS["date"], text)
        if raw_date:
            try:
                result.date = datetime.strptime(raw_date, "%d/%m/%Y").strftime("%Y-%m-%d")
            except ValueError:
                result.date = None

        result.client_name = self._extract_client_name(text)
        result.client_address = self._regex_first(PATTERNS["address"], text)
        result.responsable = self._regex_first(PATTERNS["responsable"], text)
        result.mf_field = self._regex_first(PATTERNS["mf"], text)
        result.country = "TN"

        result.line_items = self._extract_items(file_path, text)

        result.total_ht = self._parse_amount_pattern(PATTERNS["total_ht"], text)
        result.timbre_fiscal = self._parse_amount_pattern(PATTERNS["timbre"], text)
        if result.timbre_fiscal is None:
            result.timbre_fiscal = self._parse_amount_pattern(PATTERNS["timbre_alt"], text)

        # Extract TVA rate and amount — two formats:
        # GameStream: "T.V.A 19% 722,000"
        # Acrobate: "19,00% 663,480 DT" (standalone, no label)
        tva_rate_extracted = None
        tva_amount_extracted = None

        # Try labeled format first (T.V.A 19% amount)
        tva_labeled_match = re.search(PATTERNS["tva_labeled"], text, re.IGNORECASE)
        if tva_labeled_match:
            tva_rate_extracted = self._parse_amount(tva_labeled_match.group(1))
            tva_amount_extracted = self._parse_amount(tva_labeled_match.group(2))

        # Try standalone format (19,00% amount DT) — common in Acrobate invoices
        if tva_amount_extracted is None:
            tva_standalone_match = re.search(PATTERNS["tva_standalone"], text)
            if tva_standalone_match:
                tva_rate_extracted = self._parse_amount(tva_standalone_match.group(1))
                tva_amount_extracted = self._parse_amount(tva_standalone_match.group(2))

        result.tva_amount = round(float(tva_amount_extracted), 3) if tva_amount_extracted else None
        result.total_ttc = self._parse_amount_pattern(PATTERNS["total_ttc"], text)

        # Extract additional metadata
        result.amount_in_words = self._regex_first(PATTERNS["amount_in_words"], text)
        result.rib = self._regex_first(PATTERNS["rib"], text)
        result.bank = self._regex_first(PATTERNS["bank"], text)
        result.payment_method = self._regex_first(PATTERNS["payment_method"], text)
        result.seller_email = self._regex_first(PATTERNS["seller_email"], text)
        result.seller_website = self._regex_first(PATTERNS["seller_website"], text)
        # Extract client phone specifically (Téléphone: label in client section)
        client_phone = self._regex_first(r"T[ée]l[ée]phone\s*:\s*([^\n\r]+)", text)
        if client_phone:
            result.extra["client_phone"] = client_phone.strip()

        if result.total_ht is None:
            result.total_ht = round(sum(float(i.get("amount", 0)) for i in result.line_items), 3)

        # Year-aware timbre fiscal default
        _inv_year = detect_year_from_invoice(result.invoice_no, result.date, file_path)
        default_timbre = timbre_fiscal_for_year(_inv_year)
        if result.timbre_fiscal is None:
            result.timbre_fiscal = default_timbre

        # ── Guard: detect TVA/timbre confusion ──
        KNOWN_TIMBRE_VALUES = {0.5, 0.6, 0.600, 0.7, 1.0}
        if result.tva_amount and result.total_ht and result.total_ht > 0:
            if (result.tva_amount in KNOWN_TIMBRE_VALUES or
                    abs(result.tva_amount - (result.timbre_fiscal or 0)) < 0.01):
                expected_min_tva = result.total_ht * 0.05
                if result.tva_amount < expected_min_tva:
                    logger.warning(
                        f"TVA/timbre confusion detected: extracted TVA={result.tva_amount:.3f} "
                        f"matches timbre value, HT={result.total_ht:.3f}. Discarding extracted TVA."
                    )
                    result.tva_amount = None  # force recalculation

        # ── TVA cross-validation: use TTC formula as ground truth ──
        # TVA = TTC - HT - timbre is the most reliable source
        computed_tva = None
        if result.total_ttc and result.total_ttc > 0 and result.total_ht and result.total_ht > 0:
            computed_tva = round(result.total_ttc - result.total_ht - (result.timbre_fiscal or 0), 3)
            if computed_tva < 0:
                computed_tva = 0.0

        if result.tva_amount is not None and result.tva_amount > 0 and computed_tva is not None:
            # Cross-validate: if extracted TVA is wildly off from formula, use formula
            tva_deviation = abs(result.tva_amount - computed_tva)
            tolerance = max(1.0, result.total_ht * 0.01)
            if tva_deviation > tolerance:
                logger.warning(
                    f"TVA cross-validation: extracted={result.tva_amount:.3f} vs computed={computed_tva:.3f} "
                    f"(TTC={result.total_ttc:.3f} - HT={result.total_ht:.3f} - timbre={result.timbre_fiscal:.3f}). "
                    f"Using computed value."
                )
                result.tva_amount = computed_tva
        elif computed_tva is not None and computed_tva >= 0:
            result.tva_amount = computed_tva
        elif result.tva_amount is None:
            result.tva_amount = round((result.total_ht or 0) * 0.19, 3)

        # Determine TVA rate from the corrected TVA amount
        if result.tva_amount and result.tva_amount > 0 and result.total_ht and result.total_ht > 0:
            computed_rate = round(result.tva_amount / result.total_ht, 4)
            # Snap to standard Tunisian rates (7%, 13%, 19%) if close
            for std_rate in (0.07, 0.13, 0.19):
                if abs(computed_rate - std_rate) < 0.005:
                    computed_rate = std_rate
                    break
            result.tva_rate = computed_rate
        elif tva_rate_extracted and tva_rate_extracted > 0:
            result.tva_rate = round(tva_rate_extracted / 100.0, 4) if tva_rate_extracted > 1 else round(tva_rate_extracted, 4)
        elif result.tva_amount == 0:
            result.tva_rate = 0.0
        else:
            result.tva_rate = 0.19

        if result.total_ttc is None:
            result.total_ttc = round((result.total_ht or 0) + (result.tva_amount or 0) + (result.timbre_fiscal or 0), 3)

        # --- Validate totals ---
        self._validate_totals(result)
        result.extra["extraction_method"] = "pdfplumber_regex"
        source_lower = (file_path or "").lower()
        if "gamestream" in source_lower or "atlas" in source_lower:
            result.extra["company"] = "GameStream ATLAS"
        else:
            result.extra["company"] = "Acrobate Solution"

        # Detect document type from path and invoice number
        result.document_type = self._detect_doc_type(file_path, result.invoice_no)

        result.confidence = 0.92 if result.invoice_no and len(result.line_items) > 0 else 0.55

        # AI fallback only on low-confidence PDFs
        result = self._apply_ai_fallback(result)

        return result

    @staticmethod
    def _validate_totals(result: InvoiceParseResult) -> None:
        """Cross-check TVA, Total HT, and Total TTC for consistency."""
        warnings = []
        ht = float(result.total_ht or 0)
        tva = float(result.tva_amount or 0)
        timbre = float(result.timbre_fiscal or 0)
        ttc = float(result.total_ttc or 0)
        rate = float(result.tva_rate or 0)

        # Check: TVA amount ≈ Total HT × TVA rate
        if ht > 0 and rate > 0:
            expected_tva = round(ht * rate, 3)
            tva_diff = abs(tva - expected_tva)
            if tva_diff > max(1.0, ht * 0.005):
                warnings.append(f"tva-mismatch:extracted={tva:.3f}|expected={expected_tva:.3f}|rate={rate}")
                # Auto-correct: trust extracted TVA amount over computed
                if tva > 0:
                    result.tva_rate = round(tva / ht, 4)

        # Check: Total TTC ≈ Total HT + TVA + Timbre
        if ht > 0 and ttc > 0:
            expected_ttc = round(ht + tva + timbre, 3)
            ttc_diff = abs(ttc - expected_ttc)
            if ttc_diff > max(1.0, ttc * 0.005):
                warnings.append(f"ttc-mismatch:extracted={ttc:.3f}|expected={expected_ttc:.3f}|ht={ht:.3f}+tva={tva:.3f}+timbre={timbre:.3f}")

        # Check: line items total ≈ Total HT
        if result.line_items:
            items_total = round(sum(float(i.get("amount", 0)) for i in result.line_items), 3)
            if items_total > 0 and ht > 0:
                ht_diff = abs(items_total - ht)
                if ht_diff > max(1.0, ht * 0.02):
                    warnings.append(f"items-vs-ht:items_total={items_total:.3f}|total_ht={ht:.3f}")

        if warnings:
            result.extra["total_validation_warnings"] = warnings
            logger.warning(f"Total validation warnings for {result.source_file}: {warnings}")
        else:
            result.extra["totals_validated"] = True

    def _extract_text(self, file_path: str) -> str:
        try:
            with pdfplumber.open(file_path) as pdf:
                return "\n".join(p.extract_text() or "" for p in pdf.pages)
        except Exception as e:
            logger.error(f"pdfplumber failed: {e}")
            return ""

    def _ocr_fallback(self, file_path: str) -> str:
        try:
            from pdf2image import convert_from_path
            import pytesseract
            pages = convert_from_path(file_path, dpi=300)
            return "\n".join(pytesseract.image_to_string(p, lang="fra") for p in pages)
        except Exception as e:
            logger.error(f"OCR fallback failed: {e}")
            return ""

    def _extract_items(self, file_path: str, text: str) -> list[dict]:
        items: list[dict] = []
        seen = set()

        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables() or []:
                    if not table:
                        continue
                    # Try to detect column layout from the header row
                    col_map = self._detect_table_columns(table)
                    for row in table or []:
                        parsed = self._parse_row(row, col_map)
                        if not parsed:
                            continue
                        key = (parsed["ref"], parsed["description"], parsed["qty"], parsed["unitPrice"])
                        if key in seen:
                            continue
                        seen.add(key)
                        items.append(parsed)

        if items:
            return items

        # Strategy 2: Regex — REF QTY DESC UNITPRICE DT AMOUNT DT
        line_pattern = re.compile(
            r'^([A-Za-z0-9][A-Za-z0-9\-/]{0,24})\s+(\d+)\s+(.+?)\s+([\d\s,]+[.,]\d+)\s*DT\s+([\d\s,]+[.,]\d+)\s*DT',
            re.MULTILINE,
        )
        for match in line_pattern.finditer(text):
            ref = match.group(1).strip()
            qty = int(match.group(2))
            desc = match.group(3).strip()
            unit_price = self._parse_amount(match.group(4))
            amount = self._parse_amount(match.group(5))
            if unit_price is None or amount is None:
                continue
            key = (ref, desc, qty, unit_price)
            if key in seen:
                continue
            seen.add(key)
            items.append(
                {
                    "ref": ref,
                    "description": desc,
                    "qty": qty,
                    "unitPrice": round(float(unit_price), 3),
                    "amount": round(float(amount), 3),
                    "currency": "TND",
                }
            )

        # Strategy 2b: Regex — REF QTY UNITPRICE DT AMOUNT DT (no description column)
        if not items:
            no_desc_pattern = re.compile(
                r'^([A-Za-z0-9][A-Za-z0-9\-/,]{0,30})\s+(\d+)\s+([\d\s,]+[.,]\d+)\s*DT\s+([\d\s,]+[.,]\d+)\s*DT',
                re.MULTILINE,
            )
            for match in no_desc_pattern.finditer(text):
                ref = match.group(1).strip()
                qty = int(match.group(2))
                unit_price = self._parse_amount(match.group(3))
                amount = self._parse_amount(match.group(4))
                if unit_price is None or amount is None:
                    continue
                key = (ref, "", qty, unit_price)
                if key in seen:
                    continue
                seen.add(key)
                items.append(
                    {
                        "ref": ref,
                        "description": ref,
                        "qty": qty,
                        "unitPrice": round(float(unit_price), 3),
                        "amount": round(float(amount), 3),
                        "currency": "TND",
                    }
                )

        # GameStream-like layout fallback:
        # "1 Analyse des risques 1j 250,000 DT 250,000 DT"
        # "1 Electrique 1j 250,000 DT 250,000 DT"
        gamestream_pattern = re.compile(
            r'^\s*(\d+(?:[.,]\d+)?)\s+(.+?)\s+(?:\d+\s*[jh]\s+)?([\d\s,]+(?:[.,]\d+)?)\s*DT\s+([\d\s,]+(?:[.,]\d+)?)\s*DT\s*$',
            re.MULTILINE | re.IGNORECASE,
        )

        for match in gamestream_pattern.finditer(text):
            qty_raw = match.group(1).strip()
            desc = match.group(2).strip()
            unit_price = self._parse_amount(match.group(3))
            amount = self._parse_amount(match.group(4))

            if not desc or unit_price is None or amount is None:
                continue

            merged = desc.lower()
            if any(blocked in merged for blocked in ["total", "timbre", "tva", "prix par participant", "attestation", "formateurs"]):
                continue

            try:
                qty = float(qty_raw.replace(',', '.'))
            except (ValueError, TypeError):
                continue

            if qty <= 0:
                continue

            ref = re.sub(r'[^A-Za-z0-9]+', '-', desc.upper()).strip('-')[:24] or f"ITEM-{len(items) + 1}"
            normalized_qty = int(qty) if float(qty).is_integer() else qty
            key = (ref, desc, normalized_qty, round(float(unit_price), 3))
            if key in seen:
                continue

            seen.add(key)
            items.append(
                {
                    "ref": ref,
                    "description": desc,
                    "qty": normalized_qty,
                    "unitPrice": round(float(unit_price), 3),
                    "amount": round(float(amount), 3),
                    "currency": "TND",
                }
            )

        # Strategy 4: Generic numeric line pattern (no DT suffix)
        # "REF 2 Description 500.000 1000.000"
        if not items:
            generic_pattern = re.compile(
                r'^([A-Za-z0-9][A-Za-z0-9\-/]{0,24})\s+(\d+)\s+(.+?)\s+([\d\s,]+[.,]\d{2,3})\s+([\d\s,]+[.,]\d{2,3})\s*$',
                re.MULTILINE,
            )
            for match in generic_pattern.finditer(text):
                ref = match.group(1).strip()
                qty = int(match.group(2))
                desc = match.group(3).strip()
                unit_price = self._parse_amount(match.group(4))
                amount = self._parse_amount(match.group(5))
                if unit_price is None or amount is None:
                    continue
                # Skip total/summary rows
                merged_lower = desc.lower()
                if any(b in merged_lower for b in ["total", "timbre", "tva", "sous-total"]):
                    continue
                key = (ref, desc, qty, unit_price)
                if key in seen:
                    continue
                seen.add(key)
                items.append(
                    {
                        "ref": ref,
                        "description": desc,
                        "qty": qty,
                        "unitPrice": round(float(unit_price), 3),
                        "amount": round(float(amount), 3),
                        "currency": "TND",
                    }
                )

        return items

    def _detect_table_columns(self, table: list) -> dict | None:
        """Detect column layout from a PDF table header row.

        Returns a dict with column indices like:
        {"ref": 0, "qty": 1, "desc": 2, "pu": 3, "montant": 4}
        or None if no header row is detected.
        """
        for row in table[:5]:  # check first 5 rows for the header
            if not row or len(row) < 3:
                continue
            cells = [str(c or "").strip().lower() for c in row]
            merged = " ".join(cells)

            # Must look like a header row (contains at least 2 header keywords)
            header_keywords = ["réf", "ref", "quant", "qté", "p.u", "montant", "désignation",
                               "description", "code", "t.v.a", "tva"]
            matches = sum(1 for kw in header_keywords if kw in merged)
            if matches < 2:
                continue

            col_map: dict = {}
            for idx, cell_text in enumerate(cells):
                if not cell_text:
                    continue
                if "réf" in cell_text or cell_text == "ref":
                    col_map["ref"] = idx
                elif "quant" in cell_text or "qté" in cell_text or "qte" in cell_text:
                    col_map["qty"] = idx
                elif "désignation" in cell_text or "description" in cell_text:
                    col_map["desc"] = idx
                elif "p.u" in cell_text or cell_text == "pu" or "prix unitaire" in cell_text:
                    col_map["pu"] = idx
                elif "montant" in cell_text:
                    col_map["montant"] = idx
                # "Code T.V.A." column — we recognize it but don't need it for line items

            # Valid if we found at least ref + qty (or qty + montant)
            if "qty" in col_map and ("ref" in col_map or "montant" in col_map):
                return col_map

        return None

    def _parse_row(self, row, col_map: dict | None = None) -> dict | None:
        if not row or len(row) < 3:
            return None

        cells = [str(c).strip() if c is not None else "" for c in row]
        merged = " ".join(cells).lower()
        for blocked in [
            "total", "timbre", "tva", "référence", "reference", "quantité", "description", "montant",
            "signature", "cachet", "conforme", "comptant", "chèque", "virement", "arrete",
            "code t.v.a", "p.u."
        ]:
            if blocked in merged:
                return None

        # ── Use detected column layout if available ──
        if col_map and "ref" in col_map and "qty" in col_map:
            ref_idx = col_map["ref"]
            qty_idx = col_map["qty"]
            desc_idx = col_map.get("desc")  # may be None
            pu_idx = col_map.get("pu")
            montant_idx = col_map.get("montant")

            ref = cells[ref_idx] if ref_idx < len(cells) else ""
            qty_raw = cells[qty_idx] if qty_idx < len(cells) else ""
            desc = cells[desc_idx] if desc_idx is not None and desc_idx < len(cells) else ""
            if not ref or not qty_raw:
                return None

            try:
                qty = int(float(qty_raw))
            except (ValueError, TypeError):
                return None
            if qty <= 0:
                return None

            unit_price = None
            amount = None
            if pu_idx is not None and pu_idx < len(cells):
                unit_price = self._parse_amount(cells[pu_idx])
            if montant_idx is not None and montant_idx < len(cells):
                amount = self._parse_amount(cells[montant_idx])

            # Fallback: scan remaining cells for numeric values
            if unit_price is None or amount is None:
                skip_indices = {ref_idx, qty_idx}
                if desc_idx is not None:
                    skip_indices.add(desc_idx)
                numeric_vals: list[float] = []
                for ci, cell in enumerate(cells):
                    if ci in skip_indices:
                        continue
                    val = self._parse_amount(cell)
                    # Skip small integers (1-9) likely to be T.V.A. codes
                    if val is not None and val > 9 and val not in numeric_vals:
                        numeric_vals.append(val)
                if unit_price is None and len(numeric_vals) >= 1:
                    unit_price = numeric_vals[0]
                if amount is None and len(numeric_vals) >= 2:
                    amount = numeric_vals[1]

            if unit_price is None:
                return None
            if amount is None:
                amount = round(float(qty) * float(unit_price), 3)

            # Use ref as description when no description column exists
            if not desc:
                desc = ref

            return {
                "ref": ref,
                "description": desc,
                "qty": qty,
                "unitPrice": round(float(unit_price), 3),
                "amount": round(float(amount), 3),
                "currency": "TND",
            }

        # ── Default: positional parsing (cells[0]=ref, cells[1]=qty, cells[2]=desc) ──
        if len(row) < 4:
            return None

        ref = cells[0]
        qty_raw = cells[1]
        desc = cells[2] if len(cells) > 2 else ""
        if not ref or not qty_raw:
            return None

        try:
            qty = int(float(qty_raw))
        except (ValueError, TypeError):
            return None

        if qty <= 0:
            return None

        numeric_candidates: list[float] = []
        seen_numeric = set()
        for cell in cells[3:]:
            value = self._parse_amount(cell)
            if value is None or value <= 0:
                continue
            f_value = float(value)
            # Skip small integers (1-9) likely to be T.V.A. codes, not prices
            if f_value <= 9 and f_value == int(f_value):
                continue
            if f_value in seen_numeric:
                continue
            seen_numeric.add(f_value)
            numeric_candidates.append(f_value)

        if not numeric_candidates:
            return None

        unit_price = float(numeric_candidates[0])
        amount = round(float(qty) * unit_price, 3)

        if len(numeric_candidates) >= 2:
            best_pair = None
            best_score = None
            for i, up in enumerate(numeric_candidates):
                for j, amt in enumerate(numeric_candidates):
                    if i == j:
                        continue
                    score = _value_pair_score(qty, up, amt)
                    if best_score is None or score < best_score:
                        best_score = score
                        best_pair = (up, amt)

            if best_pair is not None:
                unit_price, amount = best_pair

        return {
            "ref": ref,
            "description": desc,
            "qty": qty,
            "unitPrice": round(float(unit_price), 3),
            "amount": round(float(amount), 3),
            "currency": "TND",
        }

    def _apply_ai_fallback(self, result: InvoiceParseResult) -> InvoiceParseResult:
        try:
            from ..ai_enricher import ai_enrich_invoice, should_use_ai

            parsed_payload = {
                "invoiceNo": result.invoice_no,
                "items": result.line_items,
                "totalAmount": result.total_ttc,
                "totalHT": result.total_ht,
            }
            if not should_use_ai(parsed_payload):
                return result

            ai = ai_enrich_invoice(result.raw_text or "", result.source_file)
            if not isinstance(ai, dict):
                return result

            result.invoice_no = ai.get("invoiceNo") or result.invoice_no
            result.date = ai.get("date") or result.date
            client = ai.get("client") if isinstance(ai.get("client"), dict) else {}
            result.client_name = client.get("name") or result.client_name
            result.client_address = client.get("address") or result.client_address
            result.country = client.get("country") or result.country
            result.responsable = client.get("contactName") or result.responsable
            result.mf_field = client.get("taxId") or result.mf_field
            result.commande_no = ai.get("orderNo") or result.commande_no
            result.consultation_ref = result.commande_no

            ai_items = ai.get("items") if isinstance(ai.get("items"), list) else []
            normalized = []
            for item in ai_items:
                if not isinstance(item, dict):
                    continue
                ref = str(item.get("ref") or "").strip()
                desc = str(item.get("description") or "").strip()
                qty = item.get("qty")
                unit_price = item.get("unitPrice")
                amount = item.get("amount")
                if not ref or qty is None or unit_price is None:
                    continue
                try:
                    qty_f = float(qty)
                    up_f = float(unit_price)
                    amount_f = float(amount) if amount is not None else round(qty_f * up_f, 3)
                except (ValueError, TypeError):
                    continue
                normalized.append(
                    {
                        "ref": ref,
                        "description": desc,
                        "qty": int(qty_f) if qty_f.is_integer() else qty_f,
                        "unitPrice": round(up_f, 3),
                        "amount": round(amount_f, 3),
                        "currency": "TND",
                    }
                )
            if normalized:
                result.line_items = normalized

            result.total_ht = float(ai.get("totalHT") or result.total_ht or 0)
            result.tva_amount = float(ai.get("tva") or result.tva_amount or 0)
            result.tva_rate = float(ai.get("tvaRate") or result.tva_rate or 0.19)
            # Use year-aware timbre fiscal default instead of hardcoded 0.600
            _ai_year = detect_year_from_invoice(result.invoice_no, result.date, result.source_file)
            _ai_default_timbre = timbre_fiscal_for_year(_ai_year)
            result.timbre_fiscal = float(ai.get("timbreFiscal") or result.timbre_fiscal or _ai_default_timbre)
            result.total_ttc = float(ai.get("totalTTC") or result.total_ttc or 0)
            result.extra["extraction_method"] = "pdfplumber_regex_ai_fallback"
            result.ai_confidence = 0.90
            return result
        except Exception as exc:
            logger.warning(f"AI fallback failed for {result.source_file}: {exc}")
            return result

    @staticmethod
    def _detect_doc_type(file_path: str, invoice_no: str | None = None) -> str:
        """Detect document type from file path, filename, and invoice number pattern."""
        p = (file_path or "").upper().replace("\\", "/")
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

        # 3. Invoice number pattern (fallback)
        if invoice_no:
            inv_upper = invoice_no.upper()
            if "DEVIS" in inv_upper:
                return "devis"
            if "FACTURE" in inv_upper or "FACT" in inv_upper:
                return "facture"
        return "unknown"

    @staticmethod
    def _regex_first(pattern: str, text: str) -> str | None:
        match = re.search(pattern, text, re.IGNORECASE)
        return match.group(1).strip() if match else None

    @staticmethod
    def _extract_client_name(text: str) -> str | None:
        # Strategy 1: Look for "Nom:" or "Nom " label
        for line in text.split("\n"):
            if "Nom:" in line or line.strip().startswith("Nom "):
                for sep in ("Nom:", "Nom "):
                    if sep in line:
                        value = line.split(sep, 1)[1].strip()
                        for stop in ["Date", "Commande", "Tel", "MF", "Adresse", "Responsable"]:
                            if stop in value:
                                value = value.split(stop, 1)[0].strip()
                        if value:
                            return value

        # Strategy 2: Look for "Client:" or "Client :" label
        for line in text.split("\n"):
            line_stripped = line.strip()
            for prefix in ("Client:", "Client :", "Destinataire:", "Destinataire :"):
                if prefix in line_stripped:
                    value = line_stripped.split(prefix, 1)[1].strip()
                    for stop in ["Date", "Commande", "Tel", "MF", "Adresse"]:
                        if stop in value:
                            value = value.split(stop, 1)[0].strip()
                    if value:
                        return value

        # Strategy 3: Look for "Société:" or "Societe:" label
        m = re.search(r'Soci[ée]t[ée]\s*:?\s+([^\n\r]+)', text, re.IGNORECASE)
        if m:
            value = m.group(1).strip()
            for stop in ["Date", "Commande", "Tel", "MF"]:
                if stop in value:
                    value = value.split(stop, 1)[0].strip()
            if value:
                return value

        return None

    def _parse_amount_pattern(self, pattern: str, text: str):
        match = re.search(pattern, text, re.IGNORECASE)
        if not match:
            return None
        return self._parse_amount(match.group(1))

    @staticmethod
    def _parse_amount(s: str):
        try:
            cleaned = re.sub(r'\s', '', str(s)).replace(',', '.')
            cleaned = re.sub(r'[^\d.\-]', '', cleaned)
            return float(cleaned)
        except (ValueError, TypeError):
            return None
