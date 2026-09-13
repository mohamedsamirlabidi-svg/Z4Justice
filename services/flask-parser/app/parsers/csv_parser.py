import pandas as pd
import logging
from .base_parser import BaseParser, InvoiceParseResult

logger = logging.getLogger(__name__)


def _looks_like_label_only(value) -> bool:
    if value is None:
        return False
    s = str(value).strip().lower().replace(":", "")
    return s in {"nom", "adresse", "date", "facture", "description", "reference", "référence", "montant", "total"}

class CsvParser(BaseParser):
    def can_parse(self, file_path: str) -> bool:
        return file_path.lower().endswith('.csv')

    def parse(self, file_path: str) -> InvoiceParseResult:
        result = InvoiceParseResult()
        result.source_file = file_path
        result.parser_name = 'csv_parser_v1'

        df = pd.read_csv(file_path)
        result.raw_text = df.to_csv(index=False)

        # Generic fallback mapping for CSV-based invoices
        if 'invoiceNo' in df.columns and len(df) > 0:
            result.invoice_no = str(df.iloc[0]['invoiceNo'])
        if 'date' in df.columns and len(df) > 0:
            result.date = str(df.iloc[0]['date'])
        if 'clientName' in df.columns and len(df) > 0:
            result.client_name = str(df.iloc[0]['clientName'])
        if 'totalAmount' in df.columns and len(df) > 0:
            try:
                result.total_ttc = float(df.iloc[0]['totalAmount'])
            except Exception:
                result.total_ttc = None
        
        # Extract additional CSV columns if available
        if 'responsable' in df.columns and len(df) > 0:
            result.responsable = str(df.iloc[0].get('responsable', ''))
        if 'commandeNo' in df.columns and len(df) > 0:
            result.commande_no = str(df.iloc[0].get('commandeNo', ''))
        if 'paymentMethod' in df.columns and len(df) > 0:
            result.payment_method = str(df.iloc[0].get('paymentMethod', '')).upper()

        line_items = []
        item_columns = {'description', 'quantity', 'unitPrice', 'totalPrice'}
        if item_columns.issubset(set(df.columns)):
            for _, row in df.iterrows():
                line_items.append({
                    'productCode': str(row.get('productCode', '')),
                    'description': str(row.get('description', '')),
                    'quantity': float(row.get('quantity', 0) or 0),
                    'unitPrice': float(row.get('unitPrice', 0) or 0),
                    'totalPrice': float(row.get('totalPrice', 0) or 0),
                })

        result.line_items = line_items
        result.confidence = 0.6 if result.invoice_no else 0.3
        
        # Apply AI enhancement if available
        result = self._enhance_with_ai(result)
        
        return result

    def _enhance_with_ai(self, result: InvoiceParseResult) -> InvoiceParseResult:
        """
        Enhance CSV-extracted result using OpenAI if available.
        """
        try:
            from ..openai_extractor import (
                detect_payment_method_with_ai,
                extract_table_items_with_ai,
                validate_and_correct_extracted_data,
            )
            
            if not result.raw_text:
                return result

            needs_ai = any([
                not result.invoice_no,
                not result.date,
                not result.client_name,
                result.total_ttc is None,
                not result.line_items,
            ])
            if not needs_ai:
                result.extra["extraction_method"] = result.extra.get("extraction_method") or "csv"
                return result
            
            # Enhance line items if present
            if result.line_items:
                enhanced_items = extract_table_items_with_ai(result.raw_text, result.line_items)
                if enhanced_items:
                    result.line_items = enhanced_items

            data_dict = {
                "invoiceNo": result.invoice_no,
                "date": result.date,
                "clientName": result.client_name,
                "totalTtc": result.total_ttc,
                "lineItems": result.line_items,
            }
            corrected = validate_and_correct_extracted_data(result.raw_text, data_dict)

            if isinstance(corrected, dict) and corrected is not data_dict:
                if corrected.get("invoiceNo") and not _looks_like_label_only(corrected.get("invoiceNo")):
                    result.invoice_no = str(corrected.get("invoiceNo"))
                if corrected.get("date"):
                    result.date = str(corrected.get("date"))
                if corrected.get("clientName") and not _looks_like_label_only(corrected.get("clientName")):
                    result.client_name = str(corrected.get("clientName"))
                if corrected.get("totalTtc") is not None:
                    try:
                        result.total_ttc = float(corrected.get("totalTtc"))
                    except Exception:
                        pass
                if isinstance(corrected.get("lineItems"), list) and corrected.get("lineItems"):
                    result.line_items = corrected.get("lineItems")
                result.ai_confidence = 0.8
            
            # Detect payment method if not already set
            if not result.payment_method:
                payment_method = detect_payment_method_with_ai(result.raw_text)
                if payment_method:
                    result.payment_method = payment_method
            
            result.extra["extraction_method"] = "csv_ai"
            
        except ImportError:
            logger.debug("OpenAI extractor not available for CSV")
        except Exception as e:
            logger.warning(f"CSV AI enhancement failed: {e}")
        
        return result

