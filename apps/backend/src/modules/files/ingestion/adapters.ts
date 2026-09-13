import path from 'node:path';
import { ExtractedFileContent, ParsedInvoiceItem, ParsedInvoicePayload } from './types';
import { tryParseWithOpenAI } from './openai';
import { FlaskParserResponse } from './flask-parser-client';

function detectCompanyFromHint(content: ExtractedFileContent): ParsedInvoicePayload['company'] {
  const hint = `${content.fullPath} ${content.filename} ${content.text.slice(0, 1200)}`.toLowerCase();
  if (hint.includes('acrobate')) return 'ACROBATE_SOLUTION';
  if (hint.includes('gamestream') || hint.includes('atlas')) return 'GAMESTREAM_ATLAS';
  return 'UNKNOWN';
}

function buildFastPathFromInvoiceSummary(content: ExtractedFileContent): ParsedInvoicePayload | null {
  const summary = content.invoiceSummary;
  if (!summary?.invoiceNo) {
    return null;
  }

  const company = detectCompanyFromHint(content);
  const pathContext = extractPathContext(content.fullPath);
  const invoiceDate = summary.date ? new Date(summary.date) : undefined;
  const items: ParsedInvoiceItem[] = (summary.lineItems ?? []).map((item) => ({
    name: [item.description, ...item.extraLines].filter(Boolean).join(' | ').trim() || item.reference || 'Line item',
    description: [item.description, ...item.extraLines].filter(Boolean).join(' | ').trim(),
    sku: item.reference || undefined,
    quantity: item.quantity,
    unitPrice: item.unitPrice
  }));

  const metadata = {
    responsable: summary.responsable,
    consultationRef: summary.consultationRef,
    amountInWords: summary.amountInWords,
    rib: summary.rib,
    bank: summary.bank,
    timbreFiscal: summary.timbreFiscal,
    tvaRate: typeof summary.tvaRate === 'number' ? `${(summary.tvaRate * 100).toFixed(0)}%` : null,
    sellerWebsite: summary.sellerWebsite,
    sheetNames: content.sheetNames ?? []
  };

  const logoUrl = content.logoImages?.[0] ? `${content.fullPath}#${content.logoImages[0]}` : undefined;

  return {
    company,
    invoiceNo: summary.invoiceNo,
    invoiceDate: invoiceDate && !Number.isNaN(invoiceDate.getTime()) ? invoiceDate : undefined,
    dueDate: undefined,
    currency: 'TND',
    totalAmount: summary.totalTTC ?? summary.totalHT ?? 0,
    taxAmount: summary.tvaAmount ?? 0,
    clientName: summary.clientName ?? 'Unknown',
    companyName: summary.sellerName ?? summary.companyConfig?.companyName ?? undefined,
    companyPhone: summary.companyConfig?.phone ?? undefined,
    paymentTerms: summary.consultationRef ?? undefined,
    items,
    documentType: pathContext.documentType,
    sourceYear: pathContext.year,
    notes: `parser:extractors-v2 | sheets:${(content.sheetNames ?? []).join(',')} | metadata:${JSON.stringify(metadata)}`,
    logoUrl
  };
}

function toNumber(value?: string): number {
  if (!value) {
    return 0;
  }
  const cleaned = value.replace(/[^0-9,.-]/g, '');

  const commaCount = (cleaned.match(/,/g) ?? []).length;
  const dotCount = (cleaned.match(/\./g) ?? []).length;

  let normalized = cleaned;
  if (commaCount > 0 && dotCount > 0) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (commaCount > 0 && dotCount === 0) {
    normalized = cleaned.replace(',', '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function detectCurrency(content: ExtractedFileContent): string {
  const hint = `${content.filename} ${content.fullPath} ${content.text}`.toLowerCase();

  if (/(\btnd\b|\bdt\b|dinar|دينار)/i.test(hint)) {
    return 'TND';
  }

  if (/(\beur\b|€|euro)/i.test(hint)) {
    return 'EUR';
  }

  return 'TND';
}

function findInText(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

function parseInvoiceDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\./g, '/').replace(/-/g, '/');
  const parts = normalized.split('/').map((part) => part.trim());

  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (c.length === 4) {
      const date = new Date(`${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }

  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback;
  }

  return undefined;
}

function extractPathContext(fullPath: string): {
  year?: number;
  documentType: 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';
} {
  const normalized = fullPath.replace(/\\/g, '/').toLowerCase();
  const filename = path.basename(fullPath).toLowerCase();
  const segments = normalized.split('/').filter(Boolean);

  const yearSegment = segments.find((segment) => /^20\d{2}$/.test(segment));
  const year = yearSegment ? Number(yearSegment) : undefined;

  // 1. Path folder structure (most reliable)
  const hasBonLivraisonPath =
    normalized.includes('/bon de livraison/') ||
    normalized.includes('/bon de liv/') ||
    normalized.includes('/bl/');

  const hasDevisPath = normalized.includes('/devis/');

  const hasFacturePath =
    normalized.includes('/facture/') ||
    normalized.includes('/factures/');

  // 2. Filename keywords (second priority)
  const hasBonLivraisonFilename =
    /\b(bon\s*de\s*livraison|bon\s*de\s*liv)\b/i.test(filename) ||
    /^bl\s/i.test(filename) ||
    /\sbl\s/i.test(filename);

  const hasDevisFilename =
    /\bdevis\b/i.test(filename) ||
    /\boffre\s*de\s*prix\b/i.test(filename);

  const hasFactureFilename =
    /\bfacture\b/i.test(filename);

  // BL > Devis > Facture priority (BL is most specific)
  const documentType =
    hasBonLivraisonPath || hasBonLivraisonFilename
      ? 'bon_de_livraison'
      : hasDevisPath || hasDevisFilename
        ? 'devis'
        : hasFacturePath || hasFactureFilename
          ? 'facture'
          : 'unknown';

  return { year, documentType };
}

function inferClientFromFilename(filename: string): string | undefined {
  const nameOnly = filename.replace(/\.[^.]+$/, '');
  const cleaned = nameOnly
    .replace(/\b(facture|devis|bl|offre|prix|formation|n[°o]?\s*\d+)\b/gi, ' ')
    .replace(/[0-9]{1,4}[\/-][0-9]{1,2}[\/-][0-9]{2,4}/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned.length >= 3 ? cleaned : undefined;
}

function inferInvoiceNoFromFilename(filename: string): string | undefined {
  const nameOnly = filename.replace(/\.[^.]+$/, '');
  const match = nameOnly.match(/(?:n[°o]?\s*)?([A-Z]{1,6}[\/-]?\d{2,})/i);
  return match?.[1]?.trim();
}

function pickValueByAliases(row: Record<string, string>, aliases: string[]): string {
  const entries = Object.entries(row);
  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase();
    if (aliases.some((alias) => normalizedKey.includes(alias))) {
      return value;
    }
  }
  return '';
}

function isTotalLikeRow(row: Record<string, string>): boolean {
  const merged = Object.values(row).join(' ').toLowerCase();
  return /(total|ttc|ht|tva|net\s*a\s*payer|net\s*à\s*payer|a\s*payer|à\s*payer)/.test(merged);
}

function extractNameFallback(row: Record<string, string>): string {
  const values = Object.values(row)
    .map((value) => value.trim())
    .filter(Boolean);

  const preferred = values.find((value) => /[a-zA-ZÀ-ÿ]/.test(value) && !/^\d+[.,]?\d*$/.test(value));
  return preferred ?? '';
}

function genericItemsFromRows(rows: Array<Record<string, string>>): ParsedInvoiceItem[] {
  const itemRows = rows.filter((row) => {
    if (isTotalLikeRow(row)) {
      return false;
    }

    const merged = [
      pickValueByAliases(row, ['product', 'produit']),
      pickValueByAliases(row, ['designation', 'désignation', 'article']),
      pickValueByAliases(row, ['description', 'desc']),
      pickValueByAliases(row, ['item', 'libelle', 'libellé']),
      extractNameFallback(row)
    ]
      .join(' ')
      .trim();

    return merged.length > 0;
  });

  return itemRows.map((row, index) => {
    const name =
      pickValueByAliases(row, ['product', 'produit']) ||
      pickValueByAliases(row, ['designation', 'désignation', 'article']) ||
      pickValueByAliases(row, ['description', 'desc', 'libelle', 'libellé']) ||
      pickValueByAliases(row, ['item']) ||
      extractNameFallback(row) ||
      `Line ${index + 1}`;

    const quantity =
      toNumber(
        pickValueByAliases(row, ['quantity', 'qty', 'quantite', 'quantité', 'qte', 'qté']) ||
          pickValueByAliases(row, ['nombre']) ||
          '1'
      ) || 1;

    const unitPrice =
      toNumber(
        pickValueByAliases(row, ['unit_price', 'prix_unitaire', 'pu', 'price']) ||
          pickValueByAliases(row, ['montant_unitaire', 'montant']) ||
          pickValueByAliases(row, ['amount'])
      ) || 0;

    return {
      name,
      sku:
        pickValueByAliases(row, ['sku']) ||
        pickValueByAliases(row, ['reference', 'référence', 'ref']) ||
        undefined,
      quantity,
      unitPrice
    };
  }).filter((item) => item.name.length > 0);
}

function totalFromRows(rows: Array<Record<string, string>>): number {
  for (const row of rows) {
    if (!isTotalLikeRow(row)) {
      continue;
    }

    const rowValues = Object.values(row);
    for (let i = rowValues.length - 1; i >= 0; i -= 1) {
      const parsed = toNumber(rowValues[i]);
      if (parsed > 0) {
        return parsed;
      }
    }
  }

  return 0;
}

function parseAcrobate(content: ExtractedFileContent): ParsedInvoicePayload {
  const { text, rows, filename, fullPath } = content;
  const pathContext = extractPathContext(fullPath);
  const invoiceNo =
    findInText(text, [/facture\s*(?:n[°o]|num(?:e|é)ro)?\s*[:#-]?\s*([A-Z0-9\/-]+)/i, /invoice\s*(?:no|#)?\s*[:#-]?\s*([A-Z0-9\/-]+)/i]) ??
    filename.replace(/\.[^.]+$/, '');

  const clientName =
    findInText(text, [/client\s*[:#-]?\s*([^\n\r]+)/i, /bill\s*to\s*[:#-]?\s*([^\n\r]+)/i]) ??
    'Acrobate Solution Client';

  const dateText = findInText(text, [/date\s*(?:facture|invoice)?\s*[:#-]?\s*([0-9./-]{8,12})/i]);
  const dueText = findInText(text, [/(?:echeance|due\s*date)\s*[:#-]?\s*([0-9./-]{8,12})/i]);

  const items = rows.length > 0 ? genericItemsFromRows(rows) : [{ name: 'Industrial Product Service', quantity: 1, unitPrice: 0 }];

  const totalText = findInText(text, [/(?:total\s*ttc|total\s*due|montant\s*total|total)\s*[:#-]?\s*([\d\s,.-]+)\s*(?:tnd|dt|dinar|eur|€)?/i]);
  const extractedTotal = toNumber(totalText);
  const rowTotal = totalFromRows(rows);

  return {
    company: 'ACROBATE_SOLUTION',
    clientName,
    invoiceNo,
    invoiceDate: parseInvoiceDate(dateText),
    dueDate: parseInvoiceDate(dueText),
    currency: detectCurrency(content),
    items,
    totalAmount: extractedTotal > 0 ? extractedTotal : rowTotal,
    documentType: pathContext.documentType,
    sourceYear: pathContext.year,
    confidence: rows.length > 0 ? 'high' : 'medium',
    logoUrl: content.logoImages?.[0] ? `${fullPath}#${content.logoImages[0]}` : undefined,
    notes: `parsed-from:${fullPath}`
  };
}

function parseGamestream(content: ExtractedFileContent): ParsedInvoicePayload {
  const { text, rows, filename, fullPath } = content;
  const pathContext = extractPathContext(fullPath);
  const inferredClient = inferClientFromFilename(filename);
  const inferredInvoiceNo = inferInvoiceNoFromFilename(filename);

  const invoiceNo =
    findInText(text, [/invoice\s*(?:no|number|#)?\s*[:#-]?\s*([A-Z0-9\/-]+)/i, /reference\s*[:#-]?\s*([A-Z0-9\/-]+)/i]) ??
    inferredInvoiceNo ??
    `GS-${filename.replace(/\.[^.]+$/, '')}`;

  const clientName =
    findInText(text, [/participant\s*[:#-]?\s*([^\n\r]+)/i, /client\s*[:#-]?\s*([^\n\r]+)/i, /societe\s*[:#-]?\s*([^\n\r]+)/i]) ??
    inferredClient ??
    'GameStream ATLAS Client';

  const dateText = findInText(text, [/date\s*[:#-]?\s*([0-9./-]{8,12})/i]);
  const dueText = findInText(text, [/(?:due|echeance)\s*[:#-]?\s*([0-9./-]{8,12})/i]);

  const items = rows.length > 0 ? genericItemsFromRows(rows) : [{ name: 'Training Session', quantity: 1, unitPrice: 0 }];
  const totalText = findInText(text, [/(?:total|net\s*to\s*pay|a\s*payer|à\s*payer)\s*[:#-]?\s*([\d\s,.-]+)\s*(?:tnd|dt|dinar|eur|€)?/i]);
  const extractedTotal = toNumber(totalText);
  const rowTotal = totalFromRows(rows);

  return {
    company: 'GAMESTREAM_ATLAS',
    clientName,
    invoiceNo,
    invoiceDate: parseInvoiceDate(dateText),
    dueDate: parseInvoiceDate(dueText),
    currency: detectCurrency(content),
    items,
    totalAmount: extractedTotal > 0 ? extractedTotal : rowTotal,
    logoUrl: content.logoImages?.[0] ? `${fullPath}#${content.logoImages[0]}` : undefined,
    documentType: pathContext.documentType,
    sourceYear: pathContext.year,
    confidence: rows.length > 0 ? 'high' : 'medium',
    notes: `parsed-from:${fullPath};type:${pathContext.documentType};year:${pathContext.year ?? 'na'}`
  };
}

/**
 * Map Flask parser response to ParsedInvoicePayload format.
 *
 * The Flask parser provides enhanced extraction with better field detection,
 * especially for French invoice formats.
 */
function mapFlaskParserToPayload(
  flaskData: FlaskParserResponse,
  content: ExtractedFileContent
): ParsedInvoicePayload {
  const company = detectCompanyFromHint(content);
  const pathContext = extractPathContext(content.fullPath);

  // Map Flask parser items to backend format
  const items: ParsedInvoiceItem[] = (flaskData.items ?? []).map((item) => ({
    name: item.description || item.ref || 'Line item',
    description: item.description,
    quantity: item.quantity ?? item.qty ?? 1,
    unitPrice: item.unitPrice || 0,
    sku: item.ref || undefined
  }));

  // Parse date from Flask parser (ISO format YYYY-MM-DD)
  const invoiceDate = flaskData.date ? new Date(flaskData.date) : undefined;

  // Build metadata notes
  const metadata = {
    extractionMethod: 'flask-parse-endpoint',
    vatAmount: flaskData.taxAmount,
    htAmount: flaskData.totalHT,
    commandeNo: flaskData.orderNo,
    notes: flaskData.notes
  };

  return {
    company,
    clientName: flaskData.client?.name || 'Unknown',
    invoiceNo: flaskData.invoiceNo,
    invoiceDate: invoiceDate && !Number.isNaN(invoiceDate.getTime()) ? invoiceDate : undefined,
    dueDate: undefined,
    currency: flaskData.currency || detectCurrency(content),
    totalAmount: flaskData.totalAmount ?? 0,
    taxAmount: flaskData.taxAmount ?? 0,
    taxRate: flaskData.taxRate ?? 0.19,
    timbreFiscal: flaskData.timbreFiscal ?? undefined,
    totalHT: flaskData.totalHT ?? 0,
    items: items.length > 0 ? items : [{ name: 'Service', quantity: 1, unitPrice: 0 }],
    documentType: pathContext.documentType !== 'unknown' ? pathContext.documentType : (flaskData.documentType as typeof pathContext.documentType ?? 'unknown'),
    sourceYear: pathContext.year,
    confidence: items.length > 0 && flaskData.invoiceNo ? 'high' : 'medium',
    notes: `parser:flask-enhanced | metadata:${JSON.stringify(metadata)}`,
    logoUrl: content.logoImages?.[0] ? `${content.fullPath}#${content.logoImages[0]}` : undefined,
    companyName: flaskData.company || undefined,
    companyEmail: flaskData.metadata?.sellerEmail || undefined,
    companyPhone: undefined,
    paymentTerms: flaskData.metadata?.paymentMethod || undefined
  };
}

function mergeWithAi(
  base: ParsedInvoicePayload,
  ai: Partial<ParsedInvoicePayload> | null,
  options?: { preserveAmounts?: boolean }
): ParsedInvoicePayload {
  if (!ai) {
    return base;
  }

  const keepAmounts = options?.preserveAmounts === true;
  const mergedItems = keepAmounts ? base.items : (ai.items && ai.items.length > 0 ? ai.items : base.items);

  return {
    ...base,
    clientName: ai.clientName || base.clientName,
    invoiceNo: ai.invoiceNo || base.invoiceNo,
    invoiceDate: ai.invoiceDate || base.invoiceDate,
    dueDate: ai.dueDate || base.dueDate,
    currency: ai.currency || base.currency,
    totalAmount: keepAmounts ? base.totalAmount : (typeof ai.totalAmount === 'number' ? ai.totalAmount : base.totalAmount),
    items: mergedItems,
    confidence: ai.confidence || base.confidence,
    notes: `${base.notes ?? ''};ai:${ai ? 'used' : 'none'}${keepAmounts ? ';amounts:flask' : ''}`,
    companyName: ai.companyName || base.companyName,
    companyEmail: ai.companyEmail || base.companyEmail,
    companyPhone: ai.companyPhone || base.companyPhone,
    paymentTerms: ai.paymentTerms || base.paymentTerms,
    taxRate: keepAmounts ? base.taxRate : (typeof ai.taxRate === 'number' ? ai.taxRate : base.taxRate),
    taxAmount: keepAmounts ? base.taxAmount : (typeof ai.taxAmount === 'number' ? ai.taxAmount : base.taxAmount),
    timbreFiscal: keepAmounts ? base.timbreFiscal : (typeof ai.timbreFiscal === 'number' ? ai.timbreFiscal : base.timbreFiscal),
    totalHT: keepAmounts ? base.totalHT : (typeof ai.totalHT === 'number' ? ai.totalHT : base.totalHT),
    logoUrl: ai.logoUrl || base.logoUrl
  };
}

export async function parseByCompany(
  content: ExtractedFileContent & { flaskParserData?: FlaskParserResponse },
  options?: { disableAi?: boolean; forceAi?: boolean }
): Promise<ParsedInvoicePayload> {
  const disableAi = options?.disableAi === true;
  const forceAi = options?.forceAi === true;

  // Priority 1: Use Flask parser data if available and has good confidence
  if (content.flaskParserData) {
    const flaskConfidence = content.flaskParserData.items && content.flaskParserData.items.length > 0 ? 0.9 : 0.4;

    // If Flask parser has high confidence, use it directly
    if (flaskConfidence >= 0.7) {
      console.log(`[Adapters] Using Flask parser data (confidence: ${flaskConfidence})`);
      const flaskParsed = mapFlaskParserToPayload(content.flaskParserData, content);
      if (!forceAi || disableAi) {
        return flaskParsed;
      }
      const ai = await tryParseWithOpenAI(content, {
        companyHint: flaskParsed.company,
        documentType: flaskParsed.documentType ?? 'unknown',
        sourceYear: flaskParsed.sourceYear
      });
      // Preserve Flask monetary amounts — AI often misinterprets Tunisian number format
      return mergeWithAi(flaskParsed, ai, { preserveAmounts: true });
    }

    // If Flask parser has medium confidence, use it as base but allow AI enhancement
    if (flaskConfidence >= 0.5) {
      console.log(`[Adapters] Using Flask parser with AI enhancement (confidence: ${flaskConfidence})`);
      const flaskParsed = mapFlaskParserToPayload(content.flaskParserData, content);

      // Only use AI if critical fields are missing
      const needsAi = forceAi || !flaskParsed.invoiceNo || !flaskParsed.clientName || flaskParsed.totalAmount === 0;
      if (needsAi && !disableAi) {
        const ai = await tryParseWithOpenAI(content, {
          companyHint: flaskParsed.company,
          documentType: flaskParsed.documentType ?? 'unknown',
          sourceYear: flaskParsed.sourceYear
        });
        // Preserve Flask monetary amounts when they exist — AI misinterprets Tunisian number format
        const hasFlaskAmounts = (flaskParsed.totalAmount ?? 0) > 0 && flaskParsed.items.some(i => i.unitPrice > 0);
        return mergeWithAi(flaskParsed, ai, { preserveAmounts: hasFlaskAmounts });
      }

      return flaskParsed;
    }

    // Low confidence - log and fall through to TypeScript parser
    console.log(`[Adapters] Flask parser confidence too low (${flaskConfidence}), falling back to TypeScript parser`);
  }

  // Priority 2: Use fast path from invoiceSummary (structured Excel data)
  const fastPath = buildFastPathFromInvoiceSummary(content);
  if (fastPath) {
    if (forceAi && !disableAi) {
      const ai = await tryParseWithOpenAI(content, {
        companyHint: fastPath.company,
        documentType: fastPath.documentType ?? 'unknown',
        sourceYear: fastPath.sourceYear
      });
      return mergeWithAi(fastPath, ai);
    }
    return fastPath;
  }

  // Priority 3: Use company-specific TypeScript parsers with AI fallback
  const hint = `${content.fullPath} ${content.filename} ${content.text.slice(0, 1200)}`.toLowerCase();

  if (hint.includes('acrobate')) {
    const parsed = parseAcrobate(content);
    const shouldUseAi = forceAi || parsed.items.length === 0 || !parsed.clientName || (parsed.totalAmount ?? 0) <= 0;
    const ai = shouldUseAi && !disableAi
      ? await tryParseWithOpenAI(content, {
          companyHint: 'ACROBATE_SOLUTION',
          documentType: 'unknown'
        })
      : null;
    return mergeWithAi(parsed, ai);
  }

  if (hint.includes('gamestream') || hint.includes('atlas')) {
    const parsed = parseGamestream(content);
    const shouldUseAi =
      forceAi ||
      parsed.clientName.includes('GameStream ATLAS Client') ||
      parsed.items.every((item) => item.unitPrice === 0) ||
      (parsed.totalAmount ?? 0) <= 0;

    const ai = shouldUseAi && !disableAi
      ? await tryParseWithOpenAI(content, {
          companyHint: 'GAMESTREAM_ATLAS',
          documentType: parsed.documentType,
          sourceYear: parsed.sourceYear
        })
      : null;

    return mergeWithAi(parsed, ai);
  }

  const fallback = parseAcrobate(content);
  const ai = disableAi
    ? null
    : await tryParseWithOpenAI(content, {
        companyHint: 'UNKNOWN',
        documentType: 'unknown'
      });

  return mergeWithAi({
    ...fallback,
    company: 'UNKNOWN',
    notes: `${fallback.notes};adapter:fallback`
  }, ai);
}
