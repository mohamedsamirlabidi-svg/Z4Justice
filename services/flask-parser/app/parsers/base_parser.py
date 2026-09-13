from abc import ABC, abstractmethod
from typing import Any
import logging
import re

from app.product_validator import filter_valid_items

logger = logging.getLogger(__name__)


def timbre_fiscal_for_year(year: int | None) -> float:
    """Return the correct timbre fiscal based on Tunisian law.

    - Before 2017: 0.500 DT
    - 2017–2022:   0.600 DT
    - 2023+:       1.000 DT
    """
    if year is None:
        return 1.0  # safe default = current rate
    if year <= 2016:
        return 0.5
    if year <= 2022:
        return 0.6
    return 1.0


def detect_year_from_invoice(invoice_no: str | None, date_str: str | None, source_file: str | None) -> int | None:
    """Try to determine the invoice year from various sources."""
    # 1. From invoice date
    if date_str:
        m = re.search(r'(20\d{2})', str(date_str))
        if m:
            return int(m.group(1))
    # 2. From invoice number (e.g. 2022-87, FACTURE2023-001)
    if invoice_no:
        m = re.search(r'(20\d{2})', str(invoice_no))
        if m:
            return int(m.group(1))
    # 3. From source file path (folder name like /2022/ or /FACTURE 2022/)
    if source_file:
        # Find all 4-digit year candidates in path
        years = re.findall(r'\b(20\d{2})\b', str(source_file))
        if years:
            return int(years[-1])  # last year in path is most specific
    return None

class InvoiceParseResult:
    def __init__(self):
        self.invoice_no: str | None = None
        self.date: str | None = None
        self.document_type: str | None = None  # facture, devis, bon_de_livraison, unknown
        self.client_name: str | None = None
        self.client_address: str | None = None
        self.country: str | None = None
        self.responsable: str | None = None
        self.consultation_ref: str | None = None  # N° Commande
        self.commande_no: str | None = None  # Alternative name for order number
        self.total_ht: float | None = None
        self.timbre_fiscal: float | None = None
        self.tva_rate: float | None = None
        self.tva_amount: float | None = None
        self.total_ttc: float | None = None
        self.amount_in_words: str | None = None
        self.rib: str | None = None
        self.bank: str | None = None
        self.seller_name: str | None = None
        self.seller_address: str | None = None
        self.seller_website: str | None = None
        self.seller_email: str | None = None
        self.payment_method: str | None = None  # COMPTANT or CHEQUE
        self.mf_field: str | None = None  # Custom field (MF - Montant Facturé or similar)
        self.line_items: list[dict] = []
        self.raw_text: str = ""
        self.confidence: float = 0.0
        self.ai_confidence: float = 0.0  # Confidence from AI processing
        self.parser_name: str = ""
        self.source_file: str = ""
        self.extra: dict[str, Any] = {}

    def to_dict(self) -> dict:
        def _r3(v: Any, default: float = 0.0) -> float:
            try:
                return round(float(v), 3)
            except Exception:
                return round(float(default), 3)

        normalized_items: list[dict] = []
        line_item_warnings: list[dict[str, Any]] = []
        for item in self.line_items or []:
            if not isinstance(item, dict):
                continue
            ref = str(item.get("ref") or item.get("productCode") or "").strip()
            desc = str(item.get("description") or "").strip()
            qty_raw = item.get("qty", item.get("quantity"))
            up_raw = item.get("unitPrice")
            amount_raw = item.get("amount", item.get("totalPrice"))

            try:
                qty = float(qty_raw)
                unit_price = float(up_raw)
            except Exception:
                continue

            amount = float(amount_raw) if amount_raw is not None else qty * unit_price

            expected_amount = qty * unit_price
            mismatch = abs(amount - expected_amount)
            tolerance = max(0.5, abs(expected_amount) * 0.02)
            if mismatch > tolerance:
                line_item_warnings.append(
                    {
                        "ref": ref or None,
                        "description": desc or None,
                        "qty": int(qty) if qty.is_integer() else qty,
                        "unitPrice": _r3(unit_price),
                        "extractedAmount": _r3(amount),
                        "expectedAmount": _r3(expected_amount),
                        "mismatch": _r3(mismatch),
                        "tolerance": _r3(tolerance),
                    }
                )

            normalized_items.append(
                {
                    "ref": ref,
                    "description": desc,
                    "qty": int(qty) if qty.is_integer() else qty,
                    "unitPrice": _r3(unit_price),
                    "amount": _r3(amount),
                    "currency": "TND",
                }
            )

        # ── Filter out non-product items (document refs, artifacts, etc.) ──
        valid_items, rejected_items = filter_valid_items(normalized_items, use_ai=True)
        if rejected_items:
            line_item_warnings.extend([
                {
                    "ref": r.get("ref"),
                    "description": r.get("description"),
                    "reason": "rejected_non_product",
                    "detail": r.get("_rejection_reason", "unknown"),
                }
                for r in rejected_items
            ])
        normalized_items = valid_items

        total_ht = _r3(self.total_ht if self.total_ht is not None else sum(i["amount"] for i in normalized_items))
        tax_rate = float(self.tva_rate) if self.tva_rate is not None else 0.19
        tax_amount = _r3(self.tva_amount if self.tva_amount is not None else total_ht * tax_rate)

        # Year-aware timbre fiscal default
        invoice_year = detect_year_from_invoice(self.invoice_no, self.date, self.source_file)
        default_timbre = timbre_fiscal_for_year(invoice_year)
        timbre = _r3(self.timbre_fiscal if self.timbre_fiscal is not None else default_timbre)
        total_amount = _r3(self.total_ttc if self.total_ttc is not None else total_ht + tax_amount + timbre)

        # ── Final TVA cross-validation safety net ──
        # If TTC, HT, and timbre are all available, verify TVA makes sense
        if total_amount > 0 and total_ht > 0:
            computed_tva = round(total_amount - total_ht - timbre, 3)
            if computed_tva >= 0 and abs(tax_amount - computed_tva) > max(1.0, total_ht * 0.01):
                logger.warning(
                    f"to_dict TVA cross-check: tax_amount={tax_amount:.3f} vs computed={computed_tva:.3f}. Correcting."
                )
                tax_amount = _r3(computed_tva)
                if total_ht > 0 and tax_amount > 0:
                    tax_rate = round(tax_amount / total_ht, 4)
                    # Snap to standard Tunisian rates
                    for std in (0.07, 0.13, 0.19):
                        if abs(tax_rate - std) < 0.005:
                            tax_rate = std
                            break

        if total_amount == 0:
            logger.warning(f"Parsed invoice has zero total amount: invoice_no={self.invoice_no} source={self.source_file}")

        final_confidence = self.ai_confidence if self.ai_confidence > 0 else self.confidence
        confidence_label = "high" if final_confidence >= 0.8 else ("medium" if final_confidence >= 0.5 else "low")

        source_name = str(self.source_file or "").replace("\\", "/").split("/")[-1]
        company = self.extra.get("company") or "Acrobate Solution"
        doc_type = self.document_type or self._detect_document_type(source_name, self.invoice_no)

        warning_note = f" | line-item-warnings: {len(line_item_warnings)}" if line_item_warnings else ""

        return {
            "invoiceNo": self.invoice_no,
            "date": self.date,
            "documentType": doc_type,
            "company": company,
            "currency": "TND",
            "status": "pending",
            "totalAmount": total_amount,
            "taxAmount": tax_amount,
            "taxRate": tax_rate,
            "timbreFiscal": timbre,
            "totalHT": total_ht,
            "client": {
                "name": self.client_name or "Unknown",
                "address": self.client_address or None,
                "city": self.extra.get("client_city"),
                "country": self.country or "TN",
                "phone": self.extra.get("client_phone"),
                "taxId": self.mf_field,
                "contactName": self.responsable,
            },
            "orderNo": self.commande_no or self.consultation_ref,
            "items": normalized_items,
            "sourceFile": source_name,
            "notes": f"Parsed by flask-parser v2 | items: {len(normalized_items)} | confidence: {confidence_label}{warning_note}",
            "metadata": {
                "clientAddress": self.client_address,
                "clientCity": self.extra.get("client_city"),
                "clientPhone": self.extra.get("client_phone"),
                "clientTaxId": self.mf_field,
                "clientContactName": self.responsable,
                "responsable": self.responsable,
                "consultationRef": self.consultation_ref,
                "commandeNo": self.commande_no,
                "paymentMethod": self.payment_method,
                "mfField": self.mf_field,
                "amountInWords": self.amount_in_words,
                "rib": self.rib,
                "bank": self.bank,
                "sellerName": self.seller_name,
                "sellerAddress": self.seller_address,
                "sellerWebsite": self.seller_website,
                "sellerEmail": self.seller_email,
                "extractionMethod": self.extra.get("extraction_method") or "regex",
                "aiEnhanced": self.ai_confidence > 0,
                "aiConfidence": round(self.ai_confidence, 3) if self.ai_confidence > 0 else None,
                "lineItemWarnings": line_item_warnings,
                "totalsValidated": self.extra.get("totals_validated", False),
                "totalValidationWarnings": self.extra.get("total_validation_warnings"),
            },
        }

    @staticmethod
    def _detect_document_type(source_name: str, invoice_no: str | None) -> str:
        """Detect document type from full file path, filename, and invoice number.

        Priority: path folder structure > filename keywords > invoice_no pattern.
        """
        path_normalized = str(source_name).replace("\\", "/").lower()
        filename_only = path_normalized.rsplit("/", 1)[-1] if "/" in path_normalized else path_normalized
        inv_lower = (invoice_no or "").lower()

        # 1. Path folder structure (most reliable)
        if any(seg in path_normalized for seg in ("/bon de livraison/", "/bon de liv/", "/bl/")):
            return "bon_de_livraison"
        if any(seg in path_normalized for seg in ("/devis/", "/devis ", "devis/")):
            return "devis"
        if any(seg in path_normalized for seg in ("/facture/", "/factures/", "/facture ", "facture/")):
            return "facture"

        # 2. Filename keywords
        if re.search(r'\b(bon\s*de\s*livraison|bon\s*de\s*liv)\b', filename_only):
            return "bon_de_livraison"
        if filename_only.startswith("bl ") or " bl " in filename_only:
            return "bon_de_livraison"
        if re.search(r'\b(devis|offre\s*de\s*prix|quote|quotation)\b', filename_only):
            return "devis"
        if re.search(r'\b(facture|invoice)\b', filename_only):
            return "facture"

        # 3. Invoice number pattern (fallback)
        if re.search(r'\b(devis|offre)', inv_lower):
            return "devis"
        if re.search(r'\b(facture|fact|inv)', inv_lower):
            return "facture"

        return "unknown"

class BaseParser(ABC):
    @abstractmethod
    def can_parse(self, file_path: str) -> bool:
        pass

    @abstractmethod
    def parse(self, file_path: str) -> InvoiceParseResult:
        pass
