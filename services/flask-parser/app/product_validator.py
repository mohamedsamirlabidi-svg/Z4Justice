"""
OpenAI-powered product validation.
Validates extracted line items to detect non-product entries
(document references, spreadsheet artifacts, etc.) and flag quality issues.
"""

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

# ── Regex-based fast filters (no API call needed) ──
JUNK_PATTERNS = [
    re.compile(r"^(devis|facture|offre\s*de\s*prix)\s*n[°o]?\s*\d", re.IGNORECASE),
    re.compile(r"^feuil\d*$", re.IGNORECASE),
    re.compile(r"^sheet\d*$", re.IGNORECASE),
    re.compile(r"^page\s*\d+$", re.IGNORECASE),
    re.compile(r"^\d+([.,]\d+)?$"),  # pure numbers: "299", "1.3"
    re.compile(r"^(total|sous.?total|remise|avance|acompte|retenue|timbre)", re.IGNORECASE),
    re.compile(r"^(comptant|ch[eè]que|virement|esp[eè]ces)$", re.IGNORECASE),
]


def is_junk_item(description: str) -> bool:
    """Fast regex check: returns True if the item is clearly not a product."""
    text = (description or "").strip()
    if not text or len(text) < 2:
        return True
    for pattern in JUNK_PATTERNS:
        if pattern.search(text):
            return True
    return False


def validate_items_basic(items: list[dict]) -> list[dict]:
    """
    Fast, rule-based item validation. Marks items as valid or invalid.
    Returns the filtered list with a '_valid' flag on each item.
    """
    result = []
    for item in items:
        desc = str(item.get("description") or item.get("ref") or "").strip()
        ref = str(item.get("ref") or "").strip()
        qty = item.get("qty", 0)
        unit_price = item.get("unitPrice", 0)

        if is_junk_item(desc) and is_junk_item(ref):
            item["_valid"] = False
            item["_reason"] = "junk_pattern"
        elif not desc and not ref:
            item["_valid"] = False
            item["_reason"] = "empty_description"
        else:
            item["_valid"] = True

        result.append(item)
    return result


def validate_items_with_ai(items: list[dict]) -> list[dict]:
    """
    Uses OpenAI to validate ambiguous items that passed basic filtering.
    Only calls the API for items that might be borderline.
    """
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        logger.warning("No OPENAI_API_KEY — skipping AI product validation")
        return items

    # Split items: clearly valid (has price + ref) vs ambiguous
    ambiguous = []
    ambiguous_indices = []
    for idx, item in enumerate(items):
        if not item.get("_valid", True):
            continue  # already marked invalid
        desc = str(item.get("description") or "").strip()
        ref = str(item.get("ref") or "").strip()
        price = float(item.get("unitPrice", 0))

        # Items with both ref AND price are almost certainly valid
        if ref and price > 0 and len(desc) > 3:
            continue

        # Ambiguous: no price, or short description, or suspicious name
        if price <= 0 or len(desc) < 4 or not ref:
            ambiguous.append(item)
            ambiguous_indices.append(idx)

    if not ambiguous:
        return items

    try:
        import openai
        model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        client = openai.OpenAI(api_key=api_key)

        payload = [
            {
                "idx": i,
                "ref": str(a.get("ref", "")),
                "description": str(a.get("description", "")),
                "qty": a.get("qty", 0),
                "unitPrice": a.get("unitPrice", 0),
            }
            for i, a in zip(ambiguous_indices, ambiguous)
        ]

        prompt = (
            "You are a product data validator for a Tunisian safety equipment company.\n"
            "Below is a JSON array of extracted invoice line items. For each item, determine:\n"
            "- 'valid': True if it's a real product/service (even without price)\n"
            "- 'valid': False if it's a document reference (DEVIS N°, FACTURE N°), "
            "spreadsheet artifact (Feuil1, Sheet1), pure number, or non-product text.\n\n"
            "Return ONLY a JSON array with {idx, valid, reason} for each item."
        )

        response = client.chat.completions.create(
            model=model,
            temperature=0.0,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(payload)},
            ],
        )

        text = (response.choices[0].message.content or "").strip()
        text = text.replace("```json", "").replace("```", "").strip()
        results = json.loads(text)

        for r in results:
            idx = r.get("idx")
            if idx is not None and 0 <= idx < len(items):
                if not r.get("valid", True):
                    items[idx]["_valid"] = False
                    items[idx]["_reason"] = r.get("reason", "ai_rejected")

        logger.info(f"AI validation: {len(ambiguous)} items checked, "
                     f"{sum(1 for r in results if not r.get('valid', True))} rejected")

    except Exception as e:
        logger.warning(f"AI product validation failed: {e}")
        # Don't block on AI failure — items remain as-is

    return items


def filter_valid_items(items: list[dict], use_ai: bool = True) -> tuple[list[dict], list[dict]]:
    """
    Full validation pipeline: basic + optional AI.
    Returns (valid_items, rejected_items).
    Both lists still contain all original fields.
    """
    # Step 1: basic regex filtering
    items = validate_items_basic(items)

    # Step 2: AI validation for ambiguous items
    if use_ai:
        items = validate_items_with_ai(items)

    valid = []
    rejected = []
    for item in items:
        is_valid = item.pop("_valid", True)
        reason = item.pop("_reason", None)
        if is_valid:
            valid.append(item)
        else:
            item["_rejection_reason"] = reason
            rejected.append(item)

    if rejected:
        logger.info(f"Product validation: {len(valid)} valid, {len(rejected)} rejected")
        for r in rejected[:5]:
            logger.info(f"  Rejected: '{r.get('description', '')}' — {r.get('_rejection_reason', 'unknown')}")

    return valid, rejected
