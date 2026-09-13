"""
AI enrichment fallback using OpenAI.
Called ONLY when confidence score of rule-based parser is low.
Never call for well-structured Excel files — only for PDFs or corrupted/unusual files.
"""
import os
import json
import logging

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are an invoice data extractor for Acrobat Solutions (Tunisia).
Extract structured invoice data and return ONLY valid JSON — no markdown, no explanation.

The invoices use Tunisian Dinar (TND/DT). Tax rate is usually 19%.
Timbre fiscal varies by year: 0.500 DT (before 2017), 0.600 DT (2017-2022), 1.000 DT (2023+).

Return this exact JSON schema:
{
  "invoiceNo": "string",
  "date": "YYYY-MM-DD",
  "client": {
    "name": "string",
    "address": "string or null",
    "city": "string or null",
    "country": "TN",
    "phone": "string or null",
    "taxId": "string or null",
    "contactName": "string or null"
  },
  "orderNo": "string or null",
  "items": [
    {
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "totalPrice": number,
      "productCode": "string"
    }
  ],
  "totalHT": number,
  "timbreFiscal": "number (0.5 for pre-2017, 0.6 for 2017-2022, 1.0 for 2023+)",
  "taxAmount": number,
  "taxRate": 0.19,
  "totalAmount": number,
  "currency": "TND",
  "company": "Acrobate Solution"
}

Rules:
- DO NOT duplicate line items
- totalPrice = quantity × unitPrice (verify this)
- totalHT = sum of all item totalPrice values
- taxAmount = totalHT × 0.19 (round to 3 decimals)
- totalAmount = totalHT + taxAmount + 0.600
- Skip any row that is a subtotal, header, or internal code
- If a field is missing, use null
"""


def should_use_ai(parsed_result):
    """
    Decide if AI fallback is needed based on confidence heuristics.
    Returns True if the rule-based parse result is low quality.
    """
    if not parsed_result:
        return True
    if not parsed_result.get("invoiceNo"):
        return True
    if not parsed_result.get("items") or len(parsed_result["items"]) == 0:
        return True
    if parsed_result.get("totalAmount", 0) == 0:
        return True
    # Check math integrity
    items = parsed_result.get("items", [])
    computed_ht = round(sum(i.get("totalPrice", 0) for i in items), 3)
    declared_ht = parsed_result.get("totalHT", 0) or 0
    if declared_ht > 0 and abs(computed_ht - declared_ht) > 1.0:
        return True
    return False


def ai_enrich_invoice(raw_text, filename):
    """
    Use OpenAI to extract invoice data from raw text.
    Returns parsed dict or None if AI call fails.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.debug("No OpenAI API key, skipping AI enrichment")
        return None

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)

        response = client.chat.completions.create(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Filename: {filename}\n\nRaw text:\n{raw_text[:6000]}"}
            ],
            temperature=0,
            max_tokens=2000,
        )
        content = response.choices[0].message.content.strip()
        # Strip markdown code blocks if present
        content = content.replace("```json", "").replace("```", "").strip()
        result = json.loads(content)
        logger.info(f"[AI Enricher] Successfully extracted data for {filename}")
        return result
    except Exception as e:
        logger.warning(f"[AI Enricher] Failed for {filename}: {e}")
        return None
