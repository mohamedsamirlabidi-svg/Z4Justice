import fs from 'node:fs/promises';
import { ExtractedFileContent, ParsedInvoicePayload } from './types';

const OPENAI_TIMEOUT_MS = Math.max(1000, Number(process.env.OPENAI_TIMEOUT_MS ?? 30000));
const OPENAI_RETRIES = Math.max(1, Number(process.env.OPENAI_RETRIES ?? 2));
const OPENAI_COOLDOWN_MS = Math.max(1000, Number(process.env.OPENAI_COOLDOWN_MS ?? 60000));
const OPENAI_FILE_UPLOAD_ENABLED = String(process.env.OPENAI_FILE_UPLOAD_ENABLED ?? 'true').toLowerCase() !== 'false';
const OPENAI_FILE_UPLOAD_MAX_MB = Math.max(1, Number(process.env.OPENAI_FILE_UPLOAD_MAX_MB ?? 20));

let openaiUnavailableUntil = 0;
let openaiFailureStreak = 0;
let openaiLastUnavailableLogAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldSkipOpenAI(): boolean {
  return Date.now() < openaiUnavailableUntil;
}

function markOpenAISuccess() {
  openaiFailureStreak = 0;
  openaiUnavailableUntil = 0;
}

function markOpenAIFailure(message: string) {
  openaiFailureStreak += 1;
  if (openaiFailureStreak >= 3) {
    openaiUnavailableUntil = Date.now() + OPENAI_COOLDOWN_MS;
    const now = Date.now();
    if (now - openaiLastUnavailableLogAt > 10_000) {
      openaiLastUnavailableLogAt = now;
      console.warn(
        `[OpenAI] Temporarily disabled for ${OPENAI_COOLDOWN_MS}ms after repeated failures. Last error: ${message}`
      );
    }
  }
}

function cleanJsonFence(input: string): string {
  return input
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function toDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parsePayloadFromUnknown(raw: unknown): any | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const data = raw as Record<string, unknown>;
  if (typeof data.output_text === 'string' && data.output_text.trim().length > 0) {
    try {
      return JSON.parse(cleanJsonFence(data.output_text));
    } catch {
      // continue to nested parsing
    }
  }

  const output = Array.isArray(data.output) ? data.output : [];
  for (const block of output) {
    if (!block || typeof block !== 'object') continue;
    const content = Array.isArray((block as Record<string, unknown>).content)
      ? ((block as Record<string, unknown>).content as Array<Record<string, unknown>>)
      : [];
    for (const item of content) {
      const maybeText = typeof item?.text === 'string'
        ? item.text
        : typeof item?.output_text === 'string'
          ? item.output_text
          : undefined;
      if (!maybeText) continue;
      try {
        return JSON.parse(cleanJsonFence(maybeText));
      } catch {
        // try next candidate
      }
    }
  }

  return null;
}

async function tryParseWithOpenAIUploadedFile(
  content: ExtractedFileContent,
  apiKey: string,
  model: string,
  prompt: string
): Promise<any | null> {
  if (!OPENAI_FILE_UPLOAD_ENABLED) {
    return null;
  }

  const lowerExt = (content.extension || '').toLowerCase();
  if (!['.pdf', '.csv', '.xls', '.xlsx'].includes(lowerExt)) {
    return null;
  }

  let fileId: string | null = null;
  try {
    const bytes = await fs.readFile(content.fullPath);
    if (bytes.byteLength > OPENAI_FILE_UPLOAD_MAX_MB * 1024 * 1024) {
      return null;
    }

    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob([bytes]), content.filename);

    const uploadRes = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form,
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });

    if (!uploadRes.ok) {
      return null;
    }

    const uploadData = (await uploadRes.json()) as { id?: string };
    fileId = uploadData.id ?? null;
    if (!fileId) {
      return null;
    }

    const responseRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_file', file_id: fileId }
            ]
          }
        ],
        temperature: 0.1
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });

    if (!responseRes.ok) {
      return null;
    }

    const responseData = (await responseRes.json()) as unknown;
    return parsePayloadFromUnknown(responseData);
  } catch {
    return null;
  } finally {
    if (fileId) {
      try {
        await fetch(`https://api.openai.com/v1/files/${fileId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${apiKey}`
          },
          signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
        });
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

export async function tryParseWithOpenAI(
  content: ExtractedFileContent,
  context: { companyHint?: string; documentType?: 'facture' | 'devis' | 'bon_de_livraison' | 'unknown'; sourceYear?: number }
): Promise<Partial<ParsedInvoicePayload> | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (shouldSkipOpenAI()) {
    return null;
  }

  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

  const inputPreview = {
    filename: content.filename,
    fullPath: content.fullPath,
    extension: content.extension,
    companyHint: context.companyHint,
    documentType: context.documentType,
    sourceYear: context.sourceYear,
    textPreview: content.text.slice(0, 8000),
    rowsPreview: content.rows.slice(0, 100),
    allRowsPreview: (content.allRows ?? content.rows).slice(0, 300),
    logoImages: content.logoImages ?? []
  };

  const prompt = `You are an expert invoice data extractor. Analyze the provided document data and extract ALL invoice/facture information.

IMPORTANT: Extract data EXACTLY as it appears in the source document. Do not modify, abbreviate, or transform values.

Return STRICT JSON ONLY (no markdown code fences, no extra text) with these fields:
{
  "clientName": "extracted client/customer name",
  "invoiceNo": "invoice number",
  "invoiceDate": "YYYY-MM-DD format",
  "dueDate": "YYYY-MM-DD format or null",
  "currency": "TND or other detected currency",
  "totalAmount": numeric total,
  "taxRate": tax percentage (0 if none),
  "taxAmount": calculated tax amount,
  "logoUrl": "logo/image reference if available",
  "companyName": "seller/issuer company name",
  "companyEmail": "seller email if found",
  "companyPhone": "seller phone if found",
  "paymentTerms": "payment terms or method",
  "notes": "any additional notes",
  "items": [
    {
      "description": "exact item description from table",
      "quantity": numeric quantity,
      "unitPrice": numeric unit price,
      "lineTotal": quantity * unitPrice,
      "sku": "product code/reference if available"
    }
  ],
  "confidence": "high" | "medium" | "low"
}

Document data:
${JSON.stringify(inputPreview)}

Remember: Extract EXACTLY as shown in the source. Use null for missing values, not empty strings.`;

  try {
    let response: Response | null = null;
    let lastErr = '';
    let parsed: any | null = null;

    parsed = await tryParseWithOpenAIUploadedFile(content, apiKey, model, prompt);

    for (let attempt = 1; !parsed && attempt <= OPENAI_RETRIES; attempt += 1) {
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.1,
            max_tokens: 2000
          }),
          signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
        });

        if (response.ok) {
          break;
        }

        const err = await response.text();
        lastErr = `OpenAI API error (${response.status}): ${err}`;
      } catch (error) {
        if (error instanceof Error) {
          lastErr = error.message;
        } else {
          lastErr = 'Unknown fetch error';
        }
      }

      response = null;
      if (attempt < OPENAI_RETRIES) {
        await sleep(300 * attempt);
      }
    }

    if (!parsed && (!response || !response.ok)) {
      markOpenAIFailure(lastErr || 'OpenAI request failed');
      return null;
    }

    if (!parsed) {
      const data = (await response!.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const outputText = data.choices?.[0]?.message?.content;
      if (!outputText) {
        markOpenAIFailure('Empty content from OpenAI response');
        return null;
      }

      try {
        parsed = JSON.parse(cleanJsonFence(outputText));
      } catch {
        markOpenAIFailure('Failed to parse OpenAI response as JSON');
        return null;
      }
    }

    markOpenAISuccess();

    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item: any) => ({
            name: typeof item?.description === 'string' ? item.description : typeof item?.name === 'string' ? item.name : undefined,
            description: typeof item?.description === 'string' ? item.description : undefined,
            sku: typeof item?.sku === 'string' ? item.sku : undefined,
            quantity: Number(item?.quantity ?? 0),
            unitPrice: Number(item?.unitPrice ?? 0)
          }))
          .filter((item: any) => item.name && Number.isFinite(item.quantity) && Number.isFinite(item.unitPrice))
      : undefined;

    return {
      clientName: typeof parsed.clientName === 'string' ? parsed.clientName : undefined,
      invoiceNo: typeof parsed.invoiceNo === 'string' ? parsed.invoiceNo : undefined,
      invoiceDate: toDate(parsed.invoiceDate),
      dueDate: toDate(parsed.dueDate),
      currency: typeof parsed.currency === 'string' ? parsed.currency : undefined,
      totalAmount: Number.isFinite(Number(parsed.totalAmount)) ? Number(parsed.totalAmount) : undefined,
      companyName: typeof parsed.companyName === 'string' ? parsed.companyName : undefined,
      companyEmail: typeof parsed.companyEmail === 'string' ? parsed.companyEmail : undefined,
      companyPhone: typeof parsed.companyPhone === 'string' ? parsed.companyPhone : undefined,
      paymentTerms: typeof parsed.paymentTerms === 'string' ? parsed.paymentTerms : undefined,
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
      taxRate: Number.isFinite(Number(parsed.taxRate)) ? Number(parsed.taxRate) : 0,
      taxAmount: Number.isFinite(Number(parsed.taxAmount)) ? Number(parsed.taxAmount) : 0,
      logoUrl: typeof parsed.logoUrl === 'string' ? parsed.logoUrl : undefined,
      items,
      confidence:
        parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
          ? parsed.confidence
          : undefined
    };
  } catch (error) {
    if (error instanceof Error) {
      markOpenAIFailure(error.message);
    } else {
      markOpenAIFailure('Unknown OpenAI extraction error');
    }
    return null;
  }
}
