"""
AI enrichment fallback using OpenAI.
Called ONLY when confidence score of rule-based parser is low.
Never call for well-structured Excel files — only for PDFs or corrupted/unusual files.
"""

import json
import logging
import os

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
	  "ref": "string",
	  "description": "string",
	  "qty": number,
	  "unitPrice": number,
	  "amount": number,
	  "currency": "TND"
	}
  ],
  "totalHT": number,
  "timbreFiscal": "number (0.5 for pre-2017, 0.6 for 2017-2022, 1.0 for 2023+)",
  "tva": number,
  "tvaRate": 0.19,
  "totalTTC": number,
  "currency": "TND",
  "company": "Acrobate Solution"
}

Rules:
- DO NOT duplicate line items
- amount = qty × unitPrice (verify this)
- totalHT = sum of all item amounts
- tva = totalHT × 0.19 (round to 3 decimals)
- totalTTC = totalHT + tva + 0.600
- Skip any row that is a subtotal, header, or internal code
- If a field is missing, use null
"""


def should_use_ai(parsed_result: dict) -> bool:
	if not parsed_result:
		return True
	if not parsed_result.get("invoiceNo"):
		return True
	items = parsed_result.get("items") or []
	if not items:
		return True
	if (parsed_result.get("totalTTC") or parsed_result.get("totalAmount") or 0) == 0:
		return True

	computed_ht = round(sum(float(i.get("amount", 0) or 0) for i in items if isinstance(i, dict)), 3)
	declared_ht = float(parsed_result.get("totalHT") or 0)
	if declared_ht > 0 and abs(computed_ht - declared_ht) > 0.1:
		return True
	return False


def ai_enrich_invoice(raw_text: str, filename: str) -> dict | None:
	if not os.getenv("OPENAI_API_KEY"):
		return None

	try:
		from openai import OpenAI

		client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
		response = client.chat.completions.create(
			model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
			messages=[
				{"role": "system", "content": SYSTEM_PROMPT},
				{"role": "user", "content": f"Filename: {filename}\n\nRaw text:\n{(raw_text or '')[:6000]}"},
			],
			temperature=0,
			max_tokens=2000,
		)

		content = response.choices[0].message.content.strip()
		content = content.replace("```json", "").replace("```", "").strip()
		return json.loads(content)
	except Exception as exc:
		logger.warning(f"[AI Enricher] Failed for {filename}: {exc}")
		return None
