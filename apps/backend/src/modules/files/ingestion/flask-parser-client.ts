import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

/**
 * Flask Parser Response Structure
 * Matches the output from services/flask-parser /parse endpoint.
 */
export interface FlaskParserResponse {
  invoiceNo?: string;
  date?: string;
  documentType?: string;
  company?: string;
  currency?: string;
  status?: string;
  totalAmount?: number;
  totalHT?: number;
  taxAmount?: number;
  taxRate?: number;
  timbreFiscal?: number;
  orderNo?: string;
  notes?: string;
  client?: {
    name?: string;
    address?: string | null;
    city?: string | null;
    country?: string;
    phone?: string | null;
    taxId?: string | null;
    contactName?: string | null;
  };
  items?: Array<{
    ref?: string;
    description: string;
    qty?: number;
    quantity?: number;
    unitPrice: number;
    amount?: number;
    totalPrice?: number;
  }>;
  metadata?: {
    sellerEmail?: string;
    paymentMethod?: string;
    [key: string]: unknown;
  };
}

/**
 * Configuration for Flask parser service
 */
const FLASK_PARSER_URL = process.env.FLASK_PARSER_URL || 'http://localhost:5100';
const FLASK_PARSER_TIMEOUT = parseInt(process.env.FLASK_PARSER_TIMEOUT || '30000', 10);
const FLASK_PARSER_ENABLED = process.env.FLASK_PARSER_ENABLED !== 'false';
const FLASK_PARSER_RETRIES = Math.max(1, parseInt(process.env.FLASK_PARSER_RETRIES || '2', 10));
const FLASK_PARSER_COOLDOWN_MS = Math.max(1000, parseInt(process.env.FLASK_PARSER_COOLDOWN_MS || '60000', 10));

let flaskUnavailableUntil = 0;
let flaskFailureStreak = 0;
let flaskLastUnavailableLogAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldSkipFlaskCall(): boolean {
  return Date.now() < flaskUnavailableUntil;
}

function markFlaskSuccess() {
  flaskFailureStreak = 0;
  flaskUnavailableUntil = 0;
}

function markFlaskFailure(message: string) {
  flaskFailureStreak += 1;

  if (flaskFailureStreak >= 3) {
    flaskUnavailableUntil = Date.now() + FLASK_PARSER_COOLDOWN_MS;
    const now = Date.now();
    if (now - flaskLastUnavailableLogAt > 10_000) {
      flaskLastUnavailableLogAt = now;
      console.warn(
        `[FlaskParser] Temporarily disabled for ${FLASK_PARSER_COOLDOWN_MS}ms after repeated failures. Last error: ${message}`
      );
    }
  }
}

/**
 * Call the enhanced Flask parser service to extract invoice data from a file.
 *
 * @param filePath - Absolute path to the file to parse
 * @returns Parsed invoice data from Flask parser, or null if service unavailable
 */
export async function callFlaskParser(filePath: string): Promise<FlaskParserResponse | null> {
  if (!FLASK_PARSER_ENABLED) {
    return null;
  }

  if (shouldSkipFlaskCall()) {
    return null;
  }

  try {
    // Verify file exists
    if (!fs.existsSync(filePath)) {
      console.error(`[FlaskParser] File not found: ${filePath}`);
      return null;
    }

    // Create form data with file
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), {
      filename: path.basename(filePath),
      contentType: getContentType(filePath),
    });

    let lastErr = '';
    let data: unknown = null;
    let ok = false;

    for (let attempt = 1; attempt <= FLASK_PARSER_RETRIES; attempt += 1) {
      try {
        const response = await fetch(`${FLASK_PARSER_URL}/parse`, {
          method: 'POST',
          body: form as any,
          headers: form.getHeaders(),
          signal: AbortSignal.timeout(FLASK_PARSER_TIMEOUT),
        });

        if (!response.ok) {
          lastErr = `HTTP ${response.status}: ${response.statusText}`;
        } else {
          data = await response.json();
          ok = true;
          break;
        }
      } catch (error) {
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            lastErr = `Request timeout after ${FLASK_PARSER_TIMEOUT}ms`;
          } else if (error.message.includes('ECONNREFUSED')) {
            lastErr = `Service unavailable at ${FLASK_PARSER_URL}`;
          } else {
            lastErr = error.message;
          }
        } else {
          lastErr = 'Unknown fetch error';
        }
      }

      if (attempt < FLASK_PARSER_RETRIES) {
        await sleep(250 * attempt);
      }
    }

    if (!ok) {
      markFlaskFailure(lastErr || 'fetch failed');
      return null;
    }

    // Basic validation
    if (!data || typeof data !== 'object') {
      markFlaskFailure('Invalid response format');
      return null;
    }

    markFlaskSuccess();
    console.log(`[FlaskParser] Successfully parsed: ${path.basename(filePath)}`);
    return data as FlaskParserResponse;

  } catch (error) {
    // Don't throw - allow fallback to TypeScript parser
    if (error instanceof Error) {
      markFlaskFailure(error.message);
    } else {
      markFlaskFailure('Unknown error');
    }
    return null;
  }
}

/**
 * Get content type based on file extension
 */
function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.xlsx':
    case '.xls':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.csv':
      return 'text/csv';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Check if Flask parser service is available
 */
export async function checkFlaskParserHealth(): Promise<boolean> {
  if (!FLASK_PARSER_ENABLED) {
    return false;
  }

  try {
    const response = await fetch(`${FLASK_PARSER_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
