"""OpenAI-powered intelligent invoice data extraction."""

import base64
import json
import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

def get_openai_client():
    """Return OpenAI auth/config from environment."""
    from .config import OPENAI_API_KEY, OPENAI_MODEL
    if not OPENAI_API_KEY:
        logger.warning("OPENAI_API_KEY not configured; AI extraction will be skipped")
        return None
    model = (OPENAI_MODEL or "gpt-4.1-mini").strip()
    legacy_map = {
        "gpt-4-vision-preview": "gpt-4.1-mini",
        "gpt-4-1106-vision-preview": "gpt-4.1-mini",
    }
    model = legacy_map.get(model, model)
    return OPENAI_API_KEY, model


def _extract_json_payload(text: str) -> Any:
    """Best-effort extraction of JSON object/array from model output."""
    raw = (text or "").strip()
    if not raw:
        raise ValueError("Empty model response")

    if raw.startswith("```"):
        start = raw.find("\n")
        end = raw.rfind("```")
        if start >= 0 and end > start:
            raw = raw[start + 1:end].strip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    obj_start = raw.find("{")
    obj_end = raw.rfind("}")
    arr_start = raw.find("[")
    arr_end = raw.rfind("]")

    candidates: list[str] = []
    if obj_start >= 0 and obj_end > obj_start:
        candidates.append(raw[obj_start:obj_end + 1])
    if arr_start >= 0 and arr_end > arr_start:
        candidates.append(raw[arr_start:arr_end + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue

    raise ValueError("No valid JSON found in model response")


def _call_openai_chat(messages: list[dict], max_tokens: int = 1800) -> Any | None:
    """Call OpenAI Chat Completions endpoint and parse JSON payload."""
    client_tuple = get_openai_client()
    if not client_tuple:
        return None

    api_key, model = client_tuple
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        payload = {
            "model": model,
            "temperature": 0,
            "max_tokens": max_tokens,
            "messages": messages,
            "response_format": {"type": "json_object"},
        }
        response = requests.post(url, headers=headers, json=payload, timeout=35)

        # Some keys/endpoints/models only support the newer /v1/responses API.
        if response.status_code == 404:
            responses_url = "https://api.openai.com/v1/responses"

            def _to_responses_input(msgs: list[dict]) -> list[dict]:
                converted = []
                for msg in msgs:
                    role = msg.get("role", "user")
                    content = msg.get("content", "")
                    if isinstance(content, str):
                        converted.append(
                            {
                                "role": role,
                                "content": [{"type": "input_text", "text": content}],
                            }
                        )
                        continue

                    if isinstance(content, list):
                        parts = []
                        for part in content:
                            if part.get("type") == "text":
                                parts.append({"type": "input_text", "text": part.get("text", "")})
                            elif part.get("type") == "image_url":
                                img = part.get("image_url", {})
                                parts.append({"type": "input_image", "image_url": img.get("url", "")})
                        converted.append({"role": role, "content": parts})
                return converted

            responses_payload = {
                "model": model,
                "input": _to_responses_input(messages),
                "max_output_tokens": max_tokens,
                "text": {"format": {"type": "json_object"}},
            }
            response = requests.post(responses_url, headers=headers, json=responses_payload, timeout=35)
            response.raise_for_status()
            body = response.json()

            # responses API can provide text in different locations depending on model version
            text_value = body.get("output_text")
            if not text_value:
                outputs = body.get("output", [])
                for out in outputs:
                    for item in out.get("content", []):
                        if item.get("type") in {"output_text", "text"} and item.get("text"):
                            text_value = item.get("text")
                            break
                    if text_value:
                        break
            if not text_value:
                raise ValueError("No text output returned by /v1/responses")

            return _extract_json_payload(text_value)

        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        return _extract_json_payload(content)
    except Exception as e:
        logger.warning(f"OpenAI chat call failed: {e}")
        return None


def encode_image_to_base64(image_path: str) -> str:
    """Encode image file to base64 for OpenAI vision API."""
    with open(image_path, "rb") as image_file:
        return base64.standard_b64encode(image_file.read()).decode("utf-8")


def extract_invoice_json_from_image(image_path: str) -> dict | None:
    """
    Use OpenAI's Vision API to extract invoice data from an image.
    
    Returns a structured JSON with all extracted fields.
    """
    try:
        base64_image = encode_image_to_base64(image_path)

        prompt = """
Analyze this invoice image and extract the following fields in JSON format:

{
  "invoiceNo": "Invoice number (e.g., 2025-001)",
  "date": "Invoice date in YYYY-MM-DD format",
  "commandeNo": "Order/Command number (N° Commande)",
  "responsable": "Name of responsible person",
  "clientName": "Client/Customer name",
  "clientAddress": "Client address",
  "clientCountry": "Client country code (e.g., TN for Tunisia)",
  "paymentMethod": "Payment method: 'COMPTANT' or 'CHEQUE' or null",
  "lineItems": [
    {
      "reference": "Item reference/SKU",
      "description": "Item description",
      "quantity": 1.5,
      "unitPrice": 100.00,
      "amount": 150.00
    }
  ],
  "totals": {
    "totalHT": "Total before tax (H.T.)",
    "taxRate": "Tax rate percentage (e.g., 19 for 19%)",
    "taxAmount": "Tax amount (TVA)",
    "timbreFiscal": "Fiscal stamp/fee amount",
    "totalTTC": "Total with all taxes (T.T.C.)"
  },
  "paymentTerms": "Payment terms/conditions",
  "bank": "Bank name",
  "rib": "RIB number",
  "amountInWords": "Amount written in words",
  "sellerName": "Company/Seller name",
  "sellerAddress": "Company address",
  "sellerEmail": "Company email",
  "sellerWebsite": "Company website",
  "confidence": {
    "overall": 0.95,
    "lineItems": 0.90,
    "totals": 0.98
  },
  "notes": "Any extraction notes or warnings"
}

IMPORTANT:
- NEVER use labels as values (e.g., do not return "Nom", "Adresse", "Date", "Total TTC" as data values)
- Extract ALL line items from the table
- Be precise with numerical values (decimals)
- Identify payment method by looking for checkmarks or marked options
- Return ONLY valid JSON, no markdown formatting
- Use null for missing fields
- Confidence scores: 0 to 1 scale
"""

        extracted = _call_openai_chat(
            [
                {
                    "role": "system",
                    "content": "You are a strict invoice JSON extractor. Return valid JSON only.",
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt,
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}",
                            },
                        },
                    ],
                },
            ],
            max_tokens=2000,
        )

        if not isinstance(extracted, dict):
            return None

        logger.info(f"OpenAI extraction confidence: {extracted.get('confidence', {}).get('overall', 'N/A')}")
        return extracted

    except Exception as e:
        logger.error(f"OpenAI vision extraction failed: {e}")
        return None


def validate_and_correct_extracted_data(raw_text: str, parsed_data: dict) -> dict:
    """
    Use OpenAI to validate and correct partially extracted invoice data.
    
    Cross-reference the raw text with structured parsed data to ensure accuracy.
    """
    try:
        validation_prompt = f"""
You are an invoice data validation expert. Review the following extracted invoice data against the raw text and correct any errors.

RAW TEXT SAMPLE:
{raw_text[:2000]}

PARSED DATA:
{json.dumps(parsed_data, indent=2, default=str)}

TASK:
1. Verify numerical values (totals, amounts, taxes)
2. Check date formats and ensure they are correct
3. Validate line items quantities and prices
4. Cross-check totals (Total HT + Tax + Fiscal Stamp = Total TTC)
5. Identify payment method accurately (look for checkmarks)
6. Correct any obvious errors
7. CRITICAL: Never output label text as value. Invalid examples: "Nom", "Adresse", "Date", "Total TTC", "RIB".
8. Keep field values null when unknown; do not invent values.

Return ONLY corrected JSON in this exact shape:
{{
    "correctedData": {{
        "invoiceNo": string|null,
        "date": "YYYY-MM-DD"|null,
        "clientName": string|null,
        "clientAddress": string|null,
        "responsable": string|null,
        "commandeNo": string|null,
        "totalHt": number|null,
        "tvaRate": number|null,
        "tvaAmount": number|null,
        "timbreFiscal": number|null,
        "totalTtc": number|null,
        "paymentMethod": "COMPTANT"|"CHEQUE"|null,
        "lineItems": [{{
            "productCode": string,
            "description": string,
            "quantity": number,
            "unitPrice": number,
            "totalPrice": number
        }}]
    }},
  "corrections": [
    {{"field": "fieldName", "original": "value", "corrected": "newValue", "reason": "why"}}
  ],
  "confidence": 0.95
}}
"""

        result = _call_openai_chat(
            [
                {
                    "role": "system",
                    "content": "You validate invoice extraction and return strict JSON.",
                },
                {
                    "role": "user",
                    "content": validation_prompt,
                },
            ],
            max_tokens=1600,
        )

        if not isinstance(result, dict):
            return parsed_data

        if "correctedData" in result and result["correctedData"]:
            logger.info(f"OpenAI validation applied {len(result.get('corrections', []))} corrections")
            return result["correctedData"]

        return parsed_data

    except Exception as e:
        logger.warning(f"OpenAI validation failed, using original data: {e}")
        return parsed_data


def extract_table_items_with_ai(raw_text: str, detected_items: list[dict]) -> list[dict]:
    """
    Use OpenAI to enhance and validate extracted line items.
    
    Fixes missing quantities, descriptions, or prices based on context.
    """
    if not detected_items:
        return detected_items

    try:
        enhancement_prompt = f"""
Review the following extracted invoice line items and enhance them:

RAW TEXT CONTEXT:
{raw_text[:3000]}

DETECTED ITEMS:
{json.dumps(detected_items, indent=2, default=str)}

TASK:
1. Fill in any missing quantities or prices where possible
2. Correct obvious typos in descriptions or references
3. Ensure amounts = quantity × unitPrice
4. Remove duplicate or partial items
5. Keep only complete, valid line items
6. Never keep header/label rows like "Référence", "Description", "Quantité", "Montant" as items
7. Never output label text as description unless real product/service data exists

Return ONLY corrected JSON object with key "items":
{{
  "items": [
    {{
      "productCode": "REF-001",
      "description": "Product description",
      "quantity": 2,
      "unitPrice": 50.00,
      "totalPrice": 100.00
    }}
  ]
}}
"""

        result = _call_openai_chat(
            [
                {
                    "role": "system",
                    "content": "Return invoice items as strict JSON.",
                },
                {
                    "role": "user",
                    "content": enhancement_prompt,
                },
            ],
            max_tokens=1500,
        )

        if isinstance(result, dict):
            corrected_items = result.get("items", [])
        elif isinstance(result, list):
            corrected_items = result
        else:
            return detected_items

        if not isinstance(corrected_items, list):
            return detected_items

        # normalize and guard against label rows
        cleaned_items = []
        for item in corrected_items:
            if not isinstance(item, dict):
                continue
            description = str(item.get("description") or "").strip()
            product_code = str(item.get("productCode") or item.get("reference") or "").strip()
            if description.lower() in {"description", "designation", "désignation", "libellé"}:
                continue
            if product_code.lower() in {"reference", "référence", "ref"}:
                continue
            cleaned_items.append(
                {
                    "productCode": product_code,
                    "description": description,
                    "quantity": float(item.get("quantity") or 0),
                    "unitPrice": float(item.get("unitPrice") or 0),
                    "totalPrice": float(item.get("totalPrice") or item.get("amount") or 0),
                }
            )

        if not cleaned_items:
            return detected_items

        corrected_items = cleaned_items
        logger.info(f"OpenAI enhanced {len(corrected_items)} line items")
        return corrected_items

    except Exception as e:
        logger.warning(f"OpenAI line item enhancement failed: {e}")
        return detected_items


def detect_payment_method_with_ai(raw_text: str | None) -> str | None:
    """
    Use OpenAI to detect payment method (COMPTANT or CHEQUE).
    
    Looks for checkmarks, marked options, or explicit mentions.
    """
    if not raw_text:
        return None

    try:
        prompt = f"""
Extract the payment method from this invoice text:

{raw_text}

Look for:
- Checkmarks or ☑ marks before "Comptant" or "Chèque"
- Marked/highlighted options
- Explicit mentions like "Payment: Check" or "Paid in cash"

Return ONLY one of these:
- "COMPTANT" (payment in cash/on demand)
- "CHEQUE" (payment by check)
- "AUTRE" (other/unspecified)
- null (not determined)

Return ONLY JSON:
{{ "paymentMethod": "COMPTANT" | "CHEQUE" | null }}
"""

        result = _call_openai_chat(
            [
                {
                    "role": "system",
                    "content": "Extract payment method as strict JSON.",
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
            max_tokens=80,
        )

        if not isinstance(result, dict):
            return None

        response_text = str(result.get("paymentMethod") or "").strip().upper()
        if response_text == "COMPTANT":
            return "COMPTANT"
        elif response_text == "CHEQUE":
            return "CHEQUE"
        else:
            return None

    except Exception as e:
        logger.debug(f"Payment method detection failed: {e}")
        return None


def enrich_invoice_data_with_ai(result_dict: dict) -> dict:
    """
    Post-process parsed invoice data to ensure all fields are present and accurate.
    Adds missing context fields and validates calculations.
    """
    # Ensure metadata section exists
    metadata = result_dict.get("metadata", {})
    
    # Validate totals
    total_ht = metadata.get("totalHt") or result_dict.get("totalAmount", 0)
    tax_amount = metadata.get("tvaAmount", 0) or 0
    timbre = metadata.get("timbreFiscal", 0) or 0
    total_ttc = result_dict.get("totalAmount", 0)

    # Check for inconsistencies
    expected_ttc = total_ht + tax_amount + timbre
    if abs(expected_ttc - total_ttc) > 0.01:
        logger.warning(
            f"Invoice {result_dict.get('invoiceNo')}: Total mismatch. "
            f"Expected {expected_ttc}, got {total_ttc}"
        )

    # Add AI extraction timestamp
    result_dict["aiProcessed"] = True
    metadata["extractionMethod"] = "hybrid_ai_regex"
    result_dict["metadata"] = metadata

    return result_dict
