# Flask Parser Enhancement - OpenAI Intelligent Extraction

## Overview

The Flask parser backend has been significantly enhanced with OpenAI-powered intelligent data extraction capabilities. This document outlines all improvements and new features.

## New Capabilities

### 1. **Intelligent Field Extraction**

The extractor now focuses on capturing the following key fields with high accuracy:

#### Primary Fields
- **Date** (`date`): Invoice date in YYYY-MM-DD format
- **N° Commande** (`commandeNo`): Order/Command number
- **Responsable** (`responsable`): Name of responsible person
- **Payment Method** (`paymentMethod`): COMPTANT (cash/on-demand) or CHEQUE (check)

#### Table Fields (Line Items)
Each line item now includes:
- **Référence** (`reference`): Product reference/SKU
- **Description** (`description`): Item description
- **Quantité** (`quantity`): Quantity ordered
- **P.U** (`unitPrice`): Unit price
- **Montant** (`amount`): Line total (quantity × unit price)

#### Financial Summary
- **Total H.T.** (`totalHt`): Total before tax (Hors Taxes)
- **TIMBRE FISCAL** (`timbreFiscal` / MF): Fiscal stamp/fee
- **Tax Rate & Amount** (`taxRate`, `tvaAmount`): VAT/TVA (e.g., 19%)
- **Total T.T.C.** (`totalTtc`): Total with all taxes (Toutes Taxes Comprises)

### 2. **OpenAI Vision-Based Extraction**

When processing PDF invoices, the system can optionally:
- Use OpenAI's Vision API to directly extract data from invoice images
- Identify checkmarks and marked payment methods
- Cross-reference text-based and visual data for accuracy

### 3. **Hybrid Extraction Approach**

The parser combines multiple extraction methods:

1. **Regex-based extraction**: Fast, reliable for structured documents
2. **AI validation & correction**: Fixes inconsistencies and fills gaps
3. **Payment method detection**: ML-powered identification of payment options
4. **Line item enhancement**: Fills missing quantities or prices using context

### 4. **Data Quality Checks**

Automatically validates:
- ✅ Total calculations: Base HT + Tax + Fiscal Stamp = Total TTC
- ✅ Line item integrity: Quantity × Unit Price = Amount
- ✅ Tax rate consistency: Validates against base amounts
- ✅ Missing required fields: Flags incomplete extractions

### 5. **Payment Method Detection**

Intelligently identifies:
- **Comptant**: Payment on demand/cash
- **Chèque**: Payment by check
- Detects checkmarks (☑) and marked/highlighted options in documents

## Architecture

### New Files

#### `app/openai_extractor.py`
Main module containing:
- `get_openai_client()`: Initialize OpenAI client
- `encode_image_to_base64()`: Convert images for vision API
- `extract_invoice_json_from_image()`: Direct image-to-JSON extraction
- `validate_and_correct_extracted_data()`: Cross-reference and fix errors
- `extract_table_items_with_ai()`: Enhance line items
- `detect_payment_method_with_ai()`: Identify payment type
- `enrich_invoice_data_with_ai()`: Post-process and validate

### Enhanced Files

#### `app/parsers/base_parser.py`
**New fields in `InvoiceParseResult`:**
- `commande_no`: Order number (alternative name)
- `payment_method`: COMPTANT or CHEQUE
- `mf_field`: Custom field (Montant Facturé or similar)
- `ai_confidence`: Confidence score from AI processing (0-1)

**Enhanced `to_dict()` output:**
- Includes all new fields in metadata
- Reports `aiEnhanced: true` when AI processing was applied
- Provides `aiConfidence` score for transparency

#### `app/parsers/excel_parser.py`
**New method `_enhance_with_ai()`:**
- Validates totals using AI
- Corrects line items
- Detects payment method
- Sets extraction method to "hybrid_regex_ai"

#### `app/parsers/pdf_parser.py`
**New method `_enhance_with_ai()`:**
- Similar to Excel but optimized for PDF text extraction
- Sets extraction method to "hybrid_pdf_ai"

#### `app/parsers/csv_parser.py`
**New method `_enhance_with_ai()`:**
- Extracts order number and payment method from CSV columns
- Enhances line items if present
- Sets extraction method to "csv_ai"

#### `app/adapters/gamestream_adapter.py` & `acrobate_adapter.py`
**Enhanced field mapping:**
- Maps `commandeNo` from consultation reference if needed
- Preserves payment method in metadata
- Extracts and reports AI confidence scores

## Usage

### Environment Configuration

Ensure these variables are set in `.env`:

```env
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4-vision-preview
```

### How It Works

1. **File Detection**: Parser detects file type (PDF, XLSX, CSV)
2. **Regex Extraction**: Fast initial extraction using regex patterns
3. **AI Enhancement** (if enabled):
   - Validates extracted numbers
   - Fixes incorrect dates or amounts
   - Fills missing fields using context
   - Detects payment method with high accuracy
4. **Result Generation**: Returns structured invoice with confidence scores

### Output Format

Each parsed invoice includes:

```json
{
  "invoiceNo": "2025-001",
  "date": "2025-03-22",
  "currency": "TND",
  "totalAmount": 1500.00,
  "taxAmount": 285.00,
  "taxRate": 0.19,
  "paymentTerms": "FACT-2025-001",
  "notes": "parser:excel_parser_v2 | confidence:0.95",
  "metadata": {
    "responsable": "John Doe",
    "commandeNo": "FACT-2025-001",
    "paymentMethod": "CHEQUE",
    "mfField": null,
    "amountInWords": "One thousand five hundred dinars",
    "rib": "10654000034567890123",
    "bank": "STB",
    "timbreFiscal": 5.00,
    "tvaAmount": 285.00,
    "totalHt": 1210.00,
    "tvaRate": "19%",
    "extractionMethod": "hybrid_regex_ai",
    "aiEnhanced": true,
    "aiConfidence": 0.92
  },
  "items": [
    {
      "reference": "SKU-001",
      "description": "Product A",
      "quantity": 2,
      "unitPrice": 500.00,
      "amount": 1000.00
    },
    {
      "reference": "SKU-002",
      "description": "Service B",
      "quantity": 1,
      "unitPrice": 210.00,
      "amount": 210.00
    }
  ]
}
```

## Performance Impact

- **Without AI**: ~200ms per invoice (regex only)
- **With AI**: ~3-5 seconds per invoice (depending on OpenAI latency)
- **AI is optional**: Falls back to regex-only if OpenAI key is missing or API is unavailable

## Error Handling

- If OpenAI API is unavailable: Falls back to regex extraction
- If extraction confidence is low: Flags with lower confidence score
- If required fields are missing: Still processes invoice with partial data
- Data validation errors are logged but don't block processing

## Benefits

1. **Higher Accuracy**: AI cross-references and corrects regex results
2. **Better Completeness**: Fills gaps in extraction using document context
3. **Smart Payment Detection**: Reliable identification of COMPTANT vs CHEQUE
4. **Scalable**: Supports multiple file formats (PDF, XLSX, CSV)
5. **Transparent**: Reports confidence scores and extraction method used
6. **Robust**: Graceful fallback if AI service is unavailable

## Testing the Enhancement

1. Place invoice files (PDF/XLSX) in the watch folder
2. Check Flask logs for extraction details:
   ```
   INFO: OpenAI extraction confidence: 0.95
   INFO: OpenAI enhanced 5 line items
   INFO: Parsed invoice: 2025-001 | client: ACME Inc | total: 1500.0 TND | confidence: 0.95
   ```
3. Query backend API to verify extracted metadata includes:
   - `metadata.paymentMethod`
   - `metadata.commandeNo`
   - `metadata.aiConfidence`
   - `metadata.extractionMethod`

## Future Enhancements

- [ ] Custom field extraction (MF, custom codes)
- [ ] Multi-language support (English, French, Arabic)
- [ ] Automatic currency detection
- [ ] Invoice matching and deduplication
- [ ] Batch processing with progress tracking
