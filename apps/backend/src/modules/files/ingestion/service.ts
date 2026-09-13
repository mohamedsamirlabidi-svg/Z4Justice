import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../prisma';
import { currentTenantId } from '../../../tenant-context';
import { parseByCompany } from './adapters';
import { extractFileContent, extractFileContentWithFlaskParser } from './extractors';
import type { ParsedInvoiceItem, ParsedInvoicePayload } from './types';

const acceptedExtensions = new Set(['.pdf', '.xls', '.xlsx', '.csv']);

const excelExtensions = new Set(['.xls', '.xlsx']);

function isPdfExtension(extension: string): boolean {
  return extension.toLowerCase() === '.pdf';
}

function isExcelExtension(extension: string): boolean {
  return excelExtensions.has(extension.toLowerCase());
}

function companionExtensions(extension: string): string[] {
  if (isPdfExtension(extension)) {
    return ['.xls', '.xlsx'];
  }
  if (isExcelExtension(extension)) {
    return ['.pdf'];
  }
  return [];
}

function basenameWithoutExtension(filename: string): string {
  return path.parse(filename).name.trim().toLowerCase();
}

function normalizeText(value?: string): string {
  return (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractYearFromPath(fullPath: string): number | null {
  const match = fullPath.match(/(?:^|[\\/])(20\d{2})(?:[\\/]|$)/);
  if (!match?.[1]) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

function extractCompanyHint(fullPath: string): string {
  const lower = fullPath.toLowerCase();
  if (lower.includes('acrobate')) {
    return 'ACROBATE_SOLUTION';
  }
  if (lower.includes('gamestream') || lower.includes('atlas')) {
    return 'GAMESTREAM_ATLAS';
  }
  return 'UNKNOWN';
}

function resolveCompanyForImportedFile(fullPath: string, parsedCompany?: string): string {
  if (parsedCompany && parsedCompany !== 'UNKNOWN') {
    return parsedCompany;
  }
  return extractCompanyHint(fullPath);
}

function payloadWeight(payload: ParsedInvoicePayload, extension: string): number {
  const extensionWeight = isExcelExtension(extension) ? 40 : isPdfExtension(extension) ? 20 : 10;
  const confidenceWeight = payload.confidence === 'high' ? 10 : payload.confidence === 'medium' ? 5 : 0;
  const structureWeight = (payload.items?.length ?? 0) > 0 ? 8 : 0;
  const idWeight = payload.invoiceNo ? 6 : 0;
  const totalWeight = (payload.totalAmount ?? 0) > 0 ? 4 : 0;
  return extensionWeight + confidenceWeight + structureWeight + idWeight + totalWeight;
}

function pickNumber(a?: number, b?: number, preferA = true): number | undefined {
  const aValid = typeof a === 'number' && Number.isFinite(a) && a > 0;
  const bValid = typeof b === 'number' && Number.isFinite(b) && b > 0;
  if (aValid && bValid) {
    return preferA ? a : b;
  }
  if (aValid) {
    return a;
  }
  if (bValid) {
    return b;
  }
  return undefined;
}

function mergeItemsByKey(
  left: ParsedInvoiceItem[],
  right: ParsedInvoiceItem[],
  preferLeft: boolean
): ParsedInvoiceItem[] {
  const lineTotal = (item: ParsedInvoiceItem) => {
    const qty = Number.isFinite(item.quantity) ? Number(item.quantity) : 0;
    const unit = Number.isFinite(item.unitPrice) ? Number(item.unitPrice) : 0;
    return qty > 0 && unit > 0 ? qty * unit : 0;
  };

  const keyOf = (item: ParsedInvoiceItem) => {
    const sku = normalizeText(item.sku);
    const desc = normalizeText(item.description || item.name);
    const total = lineTotal(item);
    const totalBucket = total > 0 ? total.toFixed(3) : '0';
    return `${sku}|${desc}|${totalBucket}`;
  };

  const isSuspiciousCollapsedQuantity = (item: ParsedInvoiceItem) => {
    const qty = Number.isFinite(item.quantity) ? Number(item.quantity) : 0;
    const unit = Number.isFinite(item.unitPrice) ? Number(item.unitPrice) : 0;
    return qty === 1 && unit >= 2500;
  };

  const looksLikeBetterSplit = (candidate: ParsedInvoiceItem, current: ParsedInvoiceItem) => {
    const candidateTotal = lineTotal(candidate);
    const currentTotal = lineTotal(current);
    if (candidateTotal <= 0 || currentTotal <= 0) {
      return false;
    }
    const totalClose = Math.abs(candidateTotal - currentTotal) <= Math.max(1, candidateTotal * 0.01);
    if (!totalClose) {
      return false;
    }

    const candidateQty = Number.isFinite(candidate.quantity) ? Number(candidate.quantity) : 0;
    const currentQty = Number.isFinite(current.quantity) ? Number(current.quantity) : 0;

    return candidateQty > 1 && isSuspiciousCollapsedQuantity(current);
  };

  const map = new Map<string, { item: ParsedInvoiceItem; score: number }>();
  const score = (item: ParsedInvoiceItem) => {
    const hasSku = item.sku ? 2 : 0;
    const hasDesc = (item.description || item.name)?.trim().length ? 2 : 0;
    const price = item.unitPrice > 0 ? 1 : 0;
    const qtyBonus = item.quantity > 1 ? 1 : 0;
    const collapsePenalty = isSuspiciousCollapsedQuantity(item) ? -1 : 0;
    return hasSku + hasDesc + price + qtyBonus + collapsePenalty;
  };

  const upsert = (item: ParsedInvoiceItem, sideBias: number) => {
    const key = keyOf(item);
    const current = map.get(key);
    const nextScore = score(item) + sideBias;
    if (!current) {
      map.set(key, { item, score: nextScore });
      return;
    }

    if (looksLikeBetterSplit(item, current.item)) {
      map.set(key, { item, score: nextScore + 2 });
      return;
    }

    if (nextScore > current.score) {
      map.set(key, { item, score: nextScore });
    }
  };

  for (const item of left || []) {
    upsert(item, preferLeft ? 1 : 0);
  }
  for (const item of right || []) {
    upsert(item, preferLeft ? 0 : 1);
  }

  return Array.from(map.values()).map((entry) => entry.item);
}

function mergeParsedPayloads(
  primary: ParsedInvoicePayload,
  secondary: ParsedInvoicePayload,
  primaryExtension: string,
  secondaryExtension: string,
  mergeWarnings: string[]
): ParsedInvoicePayload {
  const primaryWeight = payloadWeight(primary, primaryExtension);
  const secondaryWeight = payloadWeight(secondary, secondaryExtension);
  const preferPrimary = primaryWeight >= secondaryWeight;

  const primaryInvoiceNo = sanitizeInvoiceNo(primary.invoiceNo || '');
  const secondaryInvoiceNo = sanitizeInvoiceNo(secondary.invoiceNo || '');
  if (primaryInvoiceNo && secondaryInvoiceNo && primaryInvoiceNo !== secondaryInvoiceNo) {
    mergeWarnings.push(`pairing-invoice-no-mismatch:${primaryInvoiceNo}|${secondaryInvoiceNo}`);
  }

  const company =
    primary.company !== 'UNKNOWN' && secondary.company !== 'UNKNOWN'
      ? (preferPrimary ? primary.company : secondary.company)
      : primary.company !== 'UNKNOWN'
        ? primary.company
        : secondary.company;

  const mergedItems = mergeItemsByKey(primary.items || [], secondary.items || [], preferPrimary);

  const mergedNotes = [
    primary.notes,
    secondary.notes,
    `paired-sources:${primaryExtension}+${secondaryExtension}`,
    `pairing-strategy:field-level-merge`
  ]
    .filter((entry): entry is string => Boolean(entry && entry.trim()))
    .join(' | ');

  return {
    ...primary,
    company,
    clientName:
      (preferPrimary ? primary.clientName : secondary.clientName) ||
      (preferPrimary ? secondary.clientName : primary.clientName) ||
      primary.clientName ||
      secondary.clientName,
    invoiceNo:
      (preferPrimary ? primary.invoiceNo : secondary.invoiceNo) ||
      (preferPrimary ? secondary.invoiceNo : primary.invoiceNo),
    invoiceDate: preferPrimary ? (primary.invoiceDate || secondary.invoiceDate) : (secondary.invoiceDate || primary.invoiceDate),
    dueDate: preferPrimary ? (primary.dueDate || secondary.dueDate) : (secondary.dueDate || primary.dueDate),
    currency: (preferPrimary ? primary.currency : secondary.currency) || (preferPrimary ? secondary.currency : primary.currency),
    items: mergedItems,
    totalAmount: pickNumber(primary.totalAmount, secondary.totalAmount, preferPrimary),
    taxAmount: pickNumber(primary.taxAmount, secondary.taxAmount, preferPrimary),
    taxRate: pickNumber(primary.taxRate, secondary.taxRate, preferPrimary),
    timbreFiscal: pickNumber(primary.timbreFiscal, secondary.timbreFiscal, preferPrimary),
    totalHT: pickNumber(primary.totalHT, secondary.totalHT, preferPrimary),
    confidence: preferPrimary ? primary.confidence || secondary.confidence : secondary.confidence || primary.confidence,
    notes: mergedNotes,
    companyName: (preferPrimary ? primary.companyName : secondary.companyName) || (preferPrimary ? secondary.companyName : primary.companyName),
    companyEmail: (preferPrimary ? primary.companyEmail : secondary.companyEmail) || (preferPrimary ? secondary.companyEmail : primary.companyEmail),
    companyPhone: (preferPrimary ? primary.companyPhone : secondary.companyPhone) || (preferPrimary ? secondary.companyPhone : primary.companyPhone),
    paymentTerms: (preferPrimary ? primary.paymentTerms : secondary.paymentTerms) || (preferPrimary ? secondary.paymentTerms : primary.paymentTerms),
    logoUrl: (preferPrimary ? primary.logoUrl : secondary.logoUrl) || (preferPrimary ? secondary.logoUrl : primary.logoUrl)
  };
}

async function parseImportedPayload(
  fullPath: string,
  options?: { localOnly?: boolean; disableAi?: boolean; forceAi?: boolean }
): Promise<ParsedInvoicePayload> {
  if (options?.localOnly) {
    const content = await extractFileContent(fullPath);
    return parseByCompany(content, { disableAi: options.disableAi ?? true, forceAi: options.forceAi });
  }

  const content = await extractFileContentWithFlaskParser(fullPath);
  return parseByCompany(content, { disableAi: options?.disableAi, forceAi: options?.forceAi });
}

function calculateItemsTotal(items: Array<{ quantity: number; unitPrice: number }>): number {
  return items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
}

function nearlyEqual(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
}

function parseLooseDateString(value: string): Date | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const ddmmyyyy = trimmed.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    const candidate = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00.000Z`);
    return Number.isNaN(candidate.getTime()) ? undefined : candidate;
  }

  const isoLike = new Date(trimmed);
  return Number.isNaN(isoLike.getTime()) ? undefined : isoLike;
}

function coerceSafeInvoiceDate(input: unknown): Date | undefined {
  let parsed: Date | undefined;

  if (input instanceof Date) {
    parsed = Number.isNaN(input.getTime()) ? undefined : input;
  } else if (typeof input === 'string') {
    parsed = parseLooseDateString(input);
  } else if (input && typeof input === 'object') {
    const maybeValue = (input as { value?: unknown }).value;
    if (typeof maybeValue === 'string') {
      parsed = parseLooseDateString(maybeValue);
    }
  }

  if (!parsed) {
    return undefined;
  }

  const year = parsed.getUTCFullYear();
  if (!Number.isFinite(year) || year < 1990 || year > 2100) {
    return undefined;
  }

  return parsed;
}

export type ProcessedFileAuditResult = {
  importedFileId: string;
  filename: string;
  fullPath: string;
  issues: string[];
  warnings: string[];
  invoiceLinked: boolean;
  invoiceNo?: string;
  verified?: boolean;
  aiUpdated?: boolean;
};

type PendingRescanFile = {
  id: string;
  filename: string;
  fullPath: string;
  processedAt?: Date | null;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function findSameBasenameCrossTypeProcessed(imported: {
  id: string;
  filename: string;
  extension: string;
}): Promise<Array<{ id: string; fullPath: string; filename: string; extension: string }>> {
  const companionExts = companionExtensions(imported.extension);
  if (companionExts.length === 0) {
    return [];
  }

  const expectedBase = basenameWithoutExtension(imported.filename);
  const candidates = await prisma.importedFile.findMany({
    where: {
      id: { not: imported.id },
      extension: { in: companionExts },
      status: 'processed'
    },
    select: { id: true, fullPath: true, filename: true, extension: true },
    take: 5000
  });

  return candidates.filter((candidate) => basenameWithoutExtension(candidate.filename) === expectedBase);
}

async function auditProcessedImportedFile(
  importedFileId: string,
  options?: { useAi?: boolean }
): Promise<ProcessedFileAuditResult> {
  const imported = await prisma.importedFile.findUnique({ where: { id: importedFileId } });
  if (!imported) {
    throw new Error(`Imported file not found for audit: ${importedFileId}`);
  }

  const result: ProcessedFileAuditResult = {
    importedFileId: imported.id,
    filename: imported.filename,
    fullPath: imported.fullPath,
    issues: [],
    warnings: [],
    invoiceLinked: false
  };

  const invoice = await prisma.invoice.findFirst({
    where: { sourceFile: imported.fullPath },
    include: { items: true }
  });

  // Fallback: check pipe-separated sourceFile values in JS
  let resolvedInvoice = invoice;
  if (!resolvedInvoice) {
    const allInvoices = await prisma.invoice.findMany({
      where: { sourceFile: { not: null } },
      select: { id: true, sourceFile: true },
      take: 5000
    });
    const match = allInvoices.find((inv) => {
      if (!inv.sourceFile) return false;
      return inv.sourceFile.split('|').map((s) => s.trim()).includes(imported.fullPath);
    });
    if (match) {
      resolvedInvoice = await prisma.invoice.findFirst({
        where: { id: match.id },
        include: { items: true }
      });
    }
  }

  if (!resolvedInvoice) {
    result.issues.push('invoice-link-missing-for-source-file');
  } else {
    result.invoiceLinked = true;
    result.invoiceNo = resolvedInvoice.invoiceNo;

    const storedItemsTotal = resolvedInvoice.items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
    // totalAmount is TTC (includes tax + timbre), items sum is HT — compare correctly
    const taxRate = Number(resolvedInvoice.taxRate || 0.19);
    // Use year-aware timbre fiscal default instead of hardcoded 0.6
    const invoiceYear = extractYearFromPath(imported.fullPath);
    const defaultTimbre = invoiceYear && invoiceYear >= 2023 ? 1.0 : invoiceYear && invoiceYear <= 2016 ? 0.5 : 0.6;
    const timbre = Number(resolvedInvoice.timbreFiscal || defaultTimbre);
    const expectedTTC = storedItemsTotal + storedItemsTotal * taxRate + timbre;
    const totalHT = Number(resolvedInvoice.totalHT || 0);
    // Compare TTC vs reconstructed TTC, or if totalHT is available compare items vs HT
    const ttcClose = nearlyEqual(resolvedInvoice.totalAmount || 0, expectedTTC, Math.max(2, expectedTTC * 0.02));
    const htClose = totalHT > 0 ? nearlyEqual(totalHT, storedItemsTotal, Math.max(2, storedItemsTotal * 0.02)) : true;
    if (!ttcClose && !htClose) {
      result.warnings.push(`stored-total-vs-lines-mismatch:ttc=${resolvedInvoice.totalAmount}|itemsHT=${storedItemsTotal.toFixed(3)}|expectedTTC=${expectedTTC.toFixed(3)}`);
    }
  }

  let localContent: Awaited<ReturnType<typeof extractFileContent>> | null = null;
  try {
    localContent = await extractFileContent(imported.fullPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown-source-read-error';
    result.issues.push(`source-read-failed:${message}`);
  }

  if (localContent?.invoiceSummary && resolvedInvoice) {
    const sourceInvoiceNo = localContent.invoiceSummary.invoiceNo;
    const sourceLineItemsTotal = (localContent.invoiceSummary.lineItems ?? []).reduce(
      (sum, item) => sum + Number(item.totalPrice || 0),
      0
    );
    const sourceTotalTTC = Number(localContent.invoiceSummary.totalTTC || 0);
    const sourceTotalHT = Number(localContent.invoiceSummary.totalHT || 0);

    if (sourceInvoiceNo && sanitizeInvoiceNo(sourceInvoiceNo) !== sanitizeInvoiceNo(resolvedInvoice.invoiceNo)) {
      result.issues.push(`source-vs-stored-invoice-no-mismatch:${sourceInvoiceNo}|${resolvedInvoice.invoiceNo}`);
    }

    if (sourceTotalTTC > 0 && !nearlyEqual(sourceTotalTTC, resolvedInvoice.totalAmount || 0, 0.5)) {
      result.warnings.push(`source-totalttc-vs-stored-total-mismatch:${sourceTotalTTC}|${resolvedInvoice.totalAmount}`);
    }

    if (sourceLineItemsTotal > 0) {
      const storedItemsTotal = resolvedInvoice.items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
      if (!nearlyEqual(sourceLineItemsTotal, storedItemsTotal, 0.5)) {
        result.warnings.push(`source-lines-vs-stored-lines-mismatch:${sourceLineItemsTotal}|${storedItemsTotal.toFixed(3)}`);
      }
    }

    if (sourceTotalHT > 0 && (resolvedInvoice.totalHT ?? 0) > 0 && !nearlyEqual(sourceTotalHT, Number(resolvedInvoice.totalHT || 0), 0.5)) {
      result.warnings.push(`source-totalht-vs-stored-totalht-mismatch:${sourceTotalHT}|${resolvedInvoice.totalHT}`);
    }
  }

  const useAi = options?.useAi === true;

  let reparsed: ParsedInvoicePayload | null = null;
  try {
    reparsed = await parseImportedPayload(imported.fullPath, {
      localOnly: !useAi,
      disableAi: !useAi,
      forceAi: useAi
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown-parse-error';
    result.issues.push(`${useAi ? 'ai' : 'local'}-rescan-parse-failed:${message}`);
  }

  if (reparsed) {
    const reparsedItemsTotal = calculateItemsTotal(reparsed.items || []);
    const reparsedTotal = typeof reparsed.totalAmount === 'number' && reparsed.totalAmount > 0 ? reparsed.totalAmount : reparsedItemsTotal;
    // reparsedTotal is TTC, reparsedItemsTotal is HT — allow tax difference
    const reparsedTaxRate = typeof reparsed.taxRate === 'number' ? reparsed.taxRate : 0.19;
    const reparsedYear = extractYearFromPath(imported.fullPath);
    const reparsedDefaultTimbre = reparsedYear && reparsedYear >= 2023 ? 1.0 : reparsedYear && reparsedYear <= 2016 ? 0.5 : 0.6;
    const reparsedExpectedTTC = reparsedItemsTotal + reparsedItemsTotal * reparsedTaxRate + (reparsed.timbreFiscal ?? reparsedDefaultTimbre);
    const reparsedTTCClose = nearlyEqual(reparsedTotal, reparsedExpectedTTC, Math.max(2, reparsedExpectedTTC * 0.02));
    const reparsedHTClose = nearlyEqual(reparsedTotal, reparsedItemsTotal, Math.max(2, reparsedItemsTotal * 0.02));
    if (!reparsedTTCClose && !reparsedHTClose && reparsedItemsTotal > 0) {
      result.warnings.push(`reparsed-total-vs-items-mismatch:ttc=${reparsedTotal}|itemsHT=${reparsedItemsTotal.toFixed(3)}|expectedTTC=${reparsedExpectedTTC.toFixed(3)}`);
    }

    if (resolvedInvoice) {
      if (reparsed.invoiceNo && sanitizeInvoiceNo(reparsed.invoiceNo) !== sanitizeInvoiceNo(resolvedInvoice.invoiceNo)) {
        result.issues.push(`invoice-no-mismatch:${reparsed.invoiceNo}|${resolvedInvoice.invoiceNo}`);
      }

      if (!nearlyEqual(reparsedTotal, resolvedInvoice.totalAmount || 0, Math.max(2, (resolvedInvoice.totalAmount || 0) * 0.02))) {
        result.warnings.push(`reparsed-vs-stored-total-mismatch:${reparsedTotal}|${resolvedInvoice.totalAmount}`);
      }

      if ((reparsed.items?.length ?? 0) !== (resolvedInvoice.items?.length ?? 0)) {
        result.warnings.push(`line-count-mismatch:${reparsed.items?.length ?? 0}|${resolvedInvoice.items?.length ?? 0}`);
      }
    }
  }

  const strictCompanions = await findSameBasenameCrossTypeProcessed(imported);
  if (strictCompanions.length > 0) {
    for (const companion of strictCompanions) {
      const companionInvoice = await prisma.invoice.findFirst({ where: { sourceFile: companion.fullPath } });
      if (resolvedInvoice && companionInvoice && resolvedInvoice.invoiceNo !== companionInvoice.invoiceNo) {
        result.issues.push(
          `same-filename-cross-type-invoice-mismatch:${resolvedInvoice.invoiceNo}|${companionInvoice.invoiceNo}|${companion.filename}`
        );
      }
    }
  }

  const auditStamp = `audit:${new Date().toISOString()}|issues:${result.issues.length}|warnings:${result.warnings.length}`;
  const auditDetails = [...result.issues.map((i) => `issue:${i}`), ...result.warnings.map((w) => `warn:${w}`)].join(',');
  const existingNotes = imported.notes?.trim() || '';
  const nextNotes = [existingNotes, auditStamp, auditDetails].filter(Boolean).join('; ');

  await prisma.importedFile.update({
    where: { id: imported.id },
    data: { notes: nextNotes.slice(0, 7000) }
  });

  result.verified = result.invoiceLinked && result.issues.length === 0 && result.warnings.length === 0;

  return result;
}

export async function rescanProcessedFiles(
  limit = 100,
  options?: {
    concurrency?: number;
    useAi?: boolean;
    updateInvoice?: boolean;
    skipVerified?: boolean;
    excludeImportedFileIds?: string[];
  }
) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 2000) : 100;
  const concurrency = Number.isFinite(options?.concurrency) && (options?.concurrency ?? 0) > 0
    ? Math.min(Math.floor(options!.concurrency!), 16)
    : Math.max(1, Number(process.env.RESCAN_CONCURRENCY ?? 4));
  const useAi = options?.useAi === true;
  const updateInvoice = options?.updateInvoice !== false;
  const skipVerified = options?.skipVerified !== false;
  const excludedIds = new Set((options?.excludeImportedFileIds ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0));
  const maxDurationMs = Math.max(1000, Number(process.env.RESCAN_MAX_DURATION_MS ?? 45000));
  const perFileTimeoutMs = Math.max(1000, Number(process.env.RESCAN_FILE_TIMEOUT_MS ?? 20000));

  const startedAt = Date.now();
  const processedCandidates = await prisma.importedFile.findMany({
    where: { status: 'processed' },
    orderBy: [{ processedAt: 'desc' }, { detectedAt: 'desc' }],
    take: skipVerified ? Math.min(safeLimit * 8 + excludedIds.size, 12000) : safeLimit + excludedIds.size
  });

  let skippedVerifiedCount = 0;
  let processed = processedCandidates;
  if (skipVerified && processedCandidates.length > 0) {
    const candidatesByPath = new Map(processedCandidates.map((file) => [file.fullPath, file]));
    // Avoid Prisma/MongoDB PCRE2 regex issues with Windows paths in `in`.
    // Fetch all verified invoices with sourceFile and filter in JS.
    const allVerifiedInvoices = await prisma.invoice.findMany({
      where: {
        sourceFile: { not: null },
        verified: true
      },
      select: { sourceFile: true }
    });
    const verifiedPaths = new Set<string>();
    for (const inv of allVerifiedInvoices) {
      if (!inv.sourceFile) continue;
      for (const seg of inv.sourceFile.split('|').map((s) => s.trim())) {
        if (candidatesByPath.has(seg)) verifiedPaths.add(seg);
      }
    }
    processed = processedCandidates.filter((file) => !verifiedPaths.has(file.fullPath));
    skippedVerifiedCount = processedCandidates.length - processed.length;
  }

  if (excludedIds.size > 0) {
    processed = processed.filter((file) => !excludedIds.has(file.id));
  }

  const totalEligible = processed.length;
  if (processed.length > safeLimit) {
    processed = processed.slice(0, safeLimit);
  }

  const results: ProcessedFileAuditResult[] = [];

  const queue = [...processed];
  let stopRequested = false;
  async function worker() {
    while (queue.length > 0) {
      if (stopRequested || Date.now() - startedAt >= maxDurationMs) {
        stopRequested = true;
        break;
      }

      const file = queue.shift();
      if (!file) break;
      try {
        const preIssues: string[] = [];
        const preWarnings: string[] = [];

        if (updateInvoice) {
          try {
            await withTimeout(
              processImportedFile(file.id, { forceAi: useAi }),
              perFileTimeoutMs,
              `invoice-refresh-timeout-after-${perFileTimeoutMs}ms`
            );
          } catch (refreshError) {
            const message = refreshError instanceof Error ? refreshError.message : 'unknown-refresh-error';
            preIssues.push(`invoice-refresh-failed:${message}`);
          }
        }

        const audit = await withTimeout(
          auditProcessedImportedFile(file.id, { useAi }),
          perFileTimeoutMs,
          `audit-timeout-after-${perFileTimeoutMs}ms`
        );

        const merged: ProcessedFileAuditResult = {
          ...audit,
          issues: [...preIssues, ...audit.issues],
          warnings: [...preWarnings, ...audit.warnings],
          aiUpdated: updateInvoice && useAi
        };
        merged.verified = merged.invoiceLinked;

        if (merged.invoiceLinked) {
          await prisma.invoice.updateMany({
            where: { sourceFile: file.fullPath },
            data: { verified: merged.verified }
          });
        }

        results.push(merged);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown-audit-error';
        results.push({
          importedFileId: file.id,
          filename: file.filename,
          fullPath: file.fullPath,
          issues: [`audit-failed:${message}`],
          warnings: [],
          invoiceLinked: false,
          verified: false,
          aiUpdated: false
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  const filesWithIssues = results.filter((r) => r.issues.length > 0).length;
  const filesWithWarnings = results.filter((r) => r.warnings.length > 0).length;
  const durationMs = Date.now() - startedAt;
  const remaining = queue.length;
  const overflowEligible = Math.max(0, totalEligible - processed.length);
  const timedOut = remaining > 0 || durationMs >= maxDurationMs;
  const pending: PendingRescanFile[] = queue.slice(0, 200).map((file) => ({
    id: file.id,
    filename: file.filename,
    fullPath: file.fullPath,
    processedAt: file.processedAt
  }));
  const verifiedCount = results.filter((r) => r.verified === true).length;
  const unverifiedCount = results.length - verifiedCount;

  return {
    requested: safeLimit,
    totalEligible,
    skipVerified,
    skippedVerifiedCount,
    scanned: results.length,
    remaining,
    hasMore: overflowEligible > 0 || remaining > 0,
    pending,
    timedOut,
    verifiedCount,
    unverifiedCount,
    filesWithIssues,
    filesWithWarnings,
    durationMs,
    results
  };
}

async function findCompanionImportedFile(imported: { id: string; filename: string; extension: string; fullPath: string }) {
  const companionExts = companionExtensions(imported.extension);
  if (companionExts.length === 0) {
    return null;
  }

  const expectedBase = basenameWithoutExtension(imported.filename);
  const currentYear = extractYearFromPath(imported.fullPath);
  const currentCompany = extractCompanyHint(imported.fullPath);

  // First try an exact filename match (most efficient)
  const baseName = path.parse(imported.filename).name;
  const candidates = await prisma.importedFile.findMany({
    where: {
      id: { not: imported.id },
      extension: { in: companionExts },
      status: { not: 'failed' },
      filename: { startsWith: baseName }
    },
    orderBy: { detectedAt: 'desc' },
    take: 50
  });

  // If no match with startsWith, do a broader search
  const searchCandidates = candidates.length > 0 ? candidates : await prisma.importedFile.findMany({
    where: {
      id: { not: imported.id },
      extension: { in: companionExts },
      status: { not: 'failed' }
    },
    orderBy: { detectedAt: 'desc' },
    take: 5000
  });

  const matchedByName = searchCandidates.filter((candidate) => basenameWithoutExtension(candidate.filename) === expectedBase);
  if (matchedByName.length === 0) {
    return null;
  }

  const sameCompanyCandidates = matchedByName.filter((candidate) => {
    if (currentCompany === 'UNKNOWN') {
      return true;
    }
    return extractCompanyHint(candidate.fullPath) === currentCompany;
  });

  const scopedCandidates = sameCompanyCandidates.length > 0 ? sameCompanyCandidates : matchedByName;

  const scored = scopedCandidates
    .map((candidate) => {
      let score = 0;
      const candidateYear = extractYearFromPath(candidate.fullPath);
      const candidateCompany = extractCompanyHint(candidate.fullPath);
      if (currentYear !== null && candidateYear !== null && currentYear === candidateYear) {
        score += 4;
      }
      if (currentCompany !== 'UNKNOWN' && currentCompany === candidateCompany) {
        score += 4;
      }
      if (path.dirname(candidate.fullPath).toLowerCase() === path.dirname(imported.fullPath).toLowerCase()) {
        score += 2;
      }
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.candidate || null;
}

function sanitizeInvoiceNo(value: string): string {
  return value.replace(/[^A-Za-z0-9\/-]/g, '').slice(0, 90);
}

/**
 * Extract the numeric core from an invoice number (e.g. "2025-106" from "DEVISN2025-106").
 * Used for fuzzy comparison when different parsers extract different prefixes.
 */
function invoiceNoCore(sanitized: string): string {
  const m = sanitized.match(/(\d{4}[-/]\d+)/);
  return m ? m[1] : sanitized;
}

/**
 * Check if two invoice numbers are compatible.
 * Exact match OR same numeric core (e.g. DEVISN2025-106 vs 2025-106).
 */
function areInvoiceNosCompatible(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  const coreA = invoiceNoCore(a);
  const coreB = invoiceNoCore(b);
  return coreA === coreB;
}

async function ensureClient(clientName: string, company: string) {
  const existing = await prisma.client.findFirst({
    where: {
      name: clientName,
      company
    }
  });

  if (existing) {
    return existing;
  }

  return prisma.client.create({
    data: {
      name: clientName,
      company,
      tenantId: currentTenantId()
    }
  });
}

async function ensureProduct(name: string, unitPrice: number, sku?: string, description?: string) {
  const trimmedName = name.trim().replace(/\s+/g, ' ');
  const normalizedName = trimmedName.toLowerCase();
  const trimmedSku = sku?.trim() || '';
  const normalizedSku = trimmedSku.toLowerCase();
  const trimmedDesc = description?.trim().replace(/\s+/g, ' ') || '';

  // Determine the best display name: prefer description over ref/sku
  const displayName = (trimmedDesc && trimmedDesc.toLowerCase() !== normalizedSku)
    ? trimmedDesc
    : trimmedName;

  // ── Validate product name: detect non-product entries ──
  const productStatus = isValidProductName(displayName, unitPrice, trimmedSku)
    ? 'verified'
    : 'pending';

  // PreFetch all products once (avoids multiple DB round-trips and Prisma regex issues)
  const allProducts = await prisma.product.findMany({
    select: { id: true, name: true, sku: true, unitPrice: true, description: true, status: true }
  });

  // 1. Match by normalized SKU (case-insensitive)
  if (normalizedSku) {
    const bySku = allProducts.find(
      (p) => p.sku && p.sku.trim().toLowerCase() === normalizedSku
    );
    if (bySku) {
      const updates: Record<string, unknown> = {};
      if (displayName && displayName.toLowerCase() !== normalizedSku && bySku.name.trim().toLowerCase() === normalizedSku) {
        updates.name = displayName;
      }
      if (!bySku.description && trimmedDesc) {
        updates.description = trimmedDesc;
      }
      if (bySku.unitPrice === 0 && unitPrice > 0) {
        updates.unitPrice = unitPrice;
      }
      // Promote to verified if the incoming data makes it valid
      if (bySku.status === 'pending' && productStatus === 'verified') {
        updates.status = 'verified';
      }
      if (Object.keys(updates).length > 0) {
        await prisma.product.update({ where: { id: bySku.id }, data: updates });
      }
      return bySku;
    }
  }

  // 2. Match by normalized name (case-insensitive, trimmed, collapsed whitespace)
  if (normalizedName.length > 0) {
    const byName = allProducts.find(
      (p) => p.name.trim().replace(/\s+/g, ' ').toLowerCase() === normalizedName
    );
    if (byName) {
      const updates: Record<string, unknown> = {};
      if (!byName.sku && trimmedSku) {
        updates.sku = trimmedSku;
      }
      if (!byName.description && trimmedDesc) {
        updates.description = trimmedDesc;
      }
      if (byName.unitPrice === 0 && unitPrice > 0) {
        updates.unitPrice = unitPrice;
      }
      if (byName.status === 'pending' && productStatus === 'verified') {
        updates.status = 'verified';
      }
      if (Object.keys(updates).length > 0) {
        await prisma.product.update({ where: { id: byName.id }, data: updates });
      }
      return byName;
    }
  }

  // 3. Also try matching by description as name
  if (trimmedDesc && trimmedDesc.toLowerCase() !== normalizedName) {
    const byDesc = allProducts.find(
      (p) => p.name.trim().replace(/\s+/g, ' ').toLowerCase() === trimmedDesc.toLowerCase()
    );
    if (byDesc) {
      const updates: Record<string, unknown> = {};
      if (!byDesc.sku && trimmedSku) {
        updates.sku = trimmedSku;
      }
      if (Object.keys(updates).length > 0) {
        await prisma.product.update({ where: { id: byDesc.id }, data: updates });
      }
      return byDesc;
    }
  }

  // 4. Fuzzy match: same SKU prefix + close unit price
  if (normalizedSku.length >= 3) {
    const bySkuPrefix = allProducts.find(
      (p) =>
        p.sku &&
        (p.sku.trim().toLowerCase().startsWith(normalizedSku) ||
          normalizedSku.startsWith(p.sku.trim().toLowerCase())) &&
        Math.abs(p.unitPrice - unitPrice) <= Math.max(1, unitPrice * 0.05)
    );
    if (bySkuPrefix) {
      const updates: Record<string, unknown> = {};
      if (!bySkuPrefix.description && trimmedDesc) {
        updates.description = trimmedDesc;
      }
      if (bySkuPrefix.unitPrice === 0 && unitPrice > 0) {
        updates.unitPrice = unitPrice;
      }
      if (Object.keys(updates).length > 0) {
        await prisma.product.update({ where: { id: bySkuPrefix.id }, data: updates });
      }
      return bySkuPrefix;
    }
  }

  // 5. Accent-insensitive name match (é→e, è→e, ê→e, à→a, etc.)
  const stripAccents = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const accentFreeDisplayName = stripAccents(displayName);
  if (accentFreeDisplayName.length >= 4) {
    const byAccentFree = allProducts.find(
      (p) => stripAccents(p.name) === accentFreeDisplayName
    );
    if (byAccentFree) {
      const updates: Record<string, unknown> = {};
      if (!byAccentFree.sku && trimmedSku) {
        updates.sku = trimmedSku;
      }
      if (!byAccentFree.description && trimmedDesc) {
        updates.description = trimmedDesc;
      }
      if (byAccentFree.unitPrice === 0 && unitPrice > 0) {
        updates.unitPrice = unitPrice;
      }
      if (byAccentFree.status === 'pending' && productStatus === 'verified') {
        updates.status = 'verified';
      }
      if (Object.keys(updates).length > 0) {
        await prisma.product.update({ where: { id: byAccentFree.id }, data: updates });
      }
      return byAccentFree;
    }
  }

  return prisma.product.create({
    data: {
      name: displayName,
      description: trimmedDesc || undefined,
      sku: trimmedSku || undefined,
      unitPrice,
      status: productStatus,
      tenantId: currentTenantId(),
    }
  });
}

/**
 * Determines if a product name looks like a real product vs junk/artifact.
 * Returns true for valid product names, false for document refs, spreadsheet artifacts, etc.
 */
function isValidProductName(name: string, unitPrice: number, sku: string): boolean {
  if (!name || name.trim().length === 0) return false;

  const n = name.trim();
  const lower = n.toLowerCase();

  // Document reference patterns (DEVIS N°..., FACTURE N°..., etc.) — NOT products
  if (/^(devis|facture|offre\s*de\s*prix)\s*n[°o]?\s*\d/i.test(n)) return false;

  // Spreadsheet artifacts
  if (/^feuil\d*$/i.test(n) || /^sheet\d*$/i.test(n)) return false;

  // Pure numbers that aren't product codes (e.g., "299", "1.3", "230")
  if (/^\d+([.,]\d+)?$/.test(n) && !sku && unitPrice <= 0) return false;

  // Very short generic labels with no other data
  if (n.length <= 2 && !sku && unitPrice <= 0) return false;

  // If the name contains a price embedded (e.g., "Sangle 32,000 DT 64,000 DT")
  // it's still a product — just needs cleanup. Mark valid.

  // Valid: has a reasonable name AND (has price OR has SKU)
  if (unitPrice > 0 || sku) return true;

  // Name is long enough and descriptive — likely a real product without price/sku yet
  if (n.length >= 4) return true;

  return false;
}

export async function processImportedFile(importedFileId: string, options?: { forceAi?: boolean }) {
  const imported = await prisma.importedFile.findUnique({ where: { id: importedFileId } });
  if (!imported) {
    throw new Error(`Imported file not found for id ${importedFileId}`);
  }

  try {
    await prisma.importedFile.update({
      where: { id: imported.id },
      data: {
        status: 'processing',
        notes: 'Reading and parsing file'
      }
    });

    const forceAi = options?.forceAi === true;
    const parsed = await parseImportedPayload(imported.fullPath, { forceAi });
    let effectiveParsed = parsed;
    effectiveParsed.invoiceDate = coerceSafeInvoiceDate(effectiveParsed.invoiceDate);
    effectiveParsed.dueDate = coerceSafeInvoiceDate(effectiveParsed.dueDate);
    const mergeWarnings: string[] = [];
    const importedCompanyHint = extractCompanyHint(imported.fullPath);

    const companion = await findCompanionImportedFile(imported);
    if (companion) {
      try {
        const companionParsed = await parseImportedPayload(companion.fullPath, { forceAi });
        companionParsed.invoiceDate = coerceSafeInvoiceDate(companionParsed.invoiceDate);
        companionParsed.dueDate = coerceSafeInvoiceDate(companionParsed.dueDate);

        const currentInvoiceNo = sanitizeInvoiceNo(parsed.invoiceNo || '');
        const companionInvoiceNo = sanitizeInvoiceNo(companionParsed.invoiceNo || '');
        const invoiceNoCompatible = areInvoiceNosCompatible(currentInvoiceNo, companionInvoiceNo);
        const parsedCompanyCompatible =
          parsed.company === 'UNKNOWN' ||
          companionParsed.company === 'UNKNOWN' ||
          parsed.company === companionParsed.company;
        const hintedCompanyCompatible =
          importedCompanyHint === 'UNKNOWN' ||
          extractCompanyHint(companion.fullPath) === 'UNKNOWN' ||
          importedCompanyHint === extractCompanyHint(companion.fullPath);

        if (invoiceNoCompatible && parsedCompanyCompatible && hintedCompanyCompatible) {
          effectiveParsed = mergeParsedPayloads(parsed, companionParsed, imported.extension, companion.extension, mergeWarnings);

          await prisma.importedFile.update({
            where: { id: companion.id },
            data: {
              status: 'processed',
              processedAt: new Date(),
              notes: `Merged as pair with ${imported.filename}`
            }
          });
        } else {
          if (!invoiceNoCompatible) {
            mergeWarnings.push(`pairing-skipped-invoice-mismatch:${currentInvoiceNo}|${companionInvoiceNo}`);
          }
          if (!parsedCompanyCompatible || !hintedCompanyCompatible) {
            mergeWarnings.push(`pairing-skipped-company-mismatch:${parsed.company}|${companionParsed.company}`);
          }
        }
      } catch (pairError) {
        const message = pairError instanceof Error ? pairError.message : 'Unknown pair parse error';
        mergeWarnings.push(`pairing-failed:${message}`);
      }
    }

    const company = resolveCompanyForImportedFile(imported.fullPath, effectiveParsed.company);
    const client = await ensureClient(effectiveParsed.clientName, company);

    const invoiceNo = sanitizeInvoiceNo(effectiveParsed.invoiceNo || `${Date.now()}-${imported.filename}`);

    const invoiceDate = coerceSafeInvoiceDate(effectiveParsed.invoiceDate) ?? new Date();
    const dueDate = coerceSafeInvoiceDate(effectiveParsed.dueDate) ?? null;
    const normalizedCurrency = (effectiveParsed.currency || 'TND').toUpperCase();
    const currency = normalizedCurrency === 'EUR' ? 'TND' : normalizedCurrency;

    const totalFromItems = effectiveParsed.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const totalAmount = effectiveParsed.totalAmount && effectiveParsed.totalAmount > 0 ? effectiveParsed.totalAmount : totalFromItems;
    const totalHT = effectiveParsed.totalHT && effectiveParsed.totalHT > 0 ? effectiveParsed.totalHT : (totalFromItems > 0 ? totalFromItems : undefined);
    const fileYear = extractYearFromPath(imported.fullPath);
    const yearTimbreDefault = fileYear && fileYear >= 2023 ? 1.0 : fileYear && fileYear <= 2016 ? 0.5 : 0.6;
    const timbreFiscal = effectiveParsed.timbreFiscal ?? yearTimbreDefault;
    const documentType = effectiveParsed.documentType ?? 'unknown';
    const notesWithLogo = [
      effectiveParsed.notes,
      effectiveParsed.logoUrl ? `logo:${effectiveParsed.logoUrl}` : undefined,
      mergeWarnings.length > 0 ? `warnings:${mergeWarnings.join(',')}` : undefined
    ]
      .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
      .join('; ');

    // findFirst — invoiceNo is no longer globally unique (F6.1b). Extension
    // injects tenantId so we only match within the current tenant.
    let existingInvoice = await prisma.invoice.findFirst({
      where: { invoiceNo },
      include: { items: true }
    });

    // Fallback: find by numeric core of invoice number (e.g. 2025-106 matches DEVISN2025-106)
    if (!existingInvoice) {
      const core = invoiceNoCore(invoiceNo);
      if (core && core !== invoiceNo) {
        const coreMatches = await prisma.invoice.findMany({
          where: { invoiceNo: { contains: core } },
          include: { items: true },
          take: 5
        });
        const compatible = coreMatches.find((inv) => areInvoiceNosCompatible(sanitizeInvoiceNo(inv.invoiceNo), invoiceNo));
        if (compatible) {
          existingInvoice = compatible;
          console.log(`[Ingestion] Matched invoice ${existingInvoice.invoiceNo} by numeric core "${core}"`);
        }
      }
    }

    // Fallback: find by base filename (same name, different extension = same document)
    // Use JS-side filtering to avoid Prisma/MongoDB PCRE2 regex issues with special chars in filenames
    if (!existingInvoice) {
      const baseName = basenameWithoutExtension(imported.filename);
      if (baseName) {
        const allInvoicesWithSource = await prisma.invoice.findMany({
          where: { sourceFile: { not: null } },
          include: { items: true },
          take: 5000
        });
        const match = allInvoicesWithSource.find((inv) => {
          if (!inv.sourceFile) return false;
          // Check each pipe-separated source file segment
          return inv.sourceFile.split('|').some((seg) => {
            const segBase = basenameWithoutExtension(path.basename(seg.trim()));
            return segBase === baseName;
          });
        });
        if (match) {
          existingInvoice = match;
          console.log(`[Ingestion] Matched invoice ${existingInvoice.invoiceNo} by base filename "${baseName}"`);
        }
      }
    }

    // Fallback: check if companion ImportedFile already has a linked invoice  
    if (!existingInvoice && companion) {
      const allInvs = await prisma.invoice.findMany({
        where: { sourceFile: { not: null } },
        include: { items: true },
        take: 5000
      });
      const found = allInvs.find((inv) =>
        inv.sourceFile?.split('|').some((seg) => seg.trim() === companion.fullPath)
      );
      if (found) {
        existingInvoice = found;
        console.log(`[Ingestion] Matched invoice ${existingInvoice.invoiceNo} by companion file "${companion.filename}"`);
      }
    }

    const lineProducts = await Promise.all(
      effectiveParsed.items.map((item) => ensureProduct(item.name, item.unitPrice, item.sku, item.description))
    );

    // Cache tenant context id for the createMany-style nested writes below.
    const invoiceTenantId = currentTenantId();

    if (existingInvoice) {
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: existingInvoice.id } });

      // Keep all source files linked — don't overwrite if different file variant (e.g. .pdf vs .xlsx)
      let mergedSourceFile = imported.fullPath;
      if (existingInvoice.sourceFile && existingInvoice.sourceFile !== imported.fullPath) {
        const existingSources = (existingInvoice.sourceFile || '').split('|').map(s => s.trim()).filter(Boolean);
        if (!existingSources.includes(imported.fullPath)) {
          existingSources.push(imported.fullPath);
        }
        mergedSourceFile = existingSources.join('|');
      }

      const updated = await prisma.invoice.update({
        where: { id: existingInvoice.id },
        data: {
          date: invoiceDate,
          dueDate,
          status: 'draft',
          clientId: client.id,
          totalAmount,
          currency,
          sourceFile: mergedSourceFile,
          verified: false,
          documentType,
          totalHT,
          timbreFiscal,
          companyName: effectiveParsed.companyName,
          companyEmail: effectiveParsed.companyEmail,
          companyPhone: effectiveParsed.companyPhone,
          paymentTerms: effectiveParsed.paymentTerms,
          taxRate: effectiveParsed.taxRate ?? 0,
          taxAmount: effectiveParsed.taxAmount ?? 0,
          notes: notesWithLogo || effectiveParsed.notes,
          items: {
            create: effectiveParsed.items.map((item, index) => ({
              productId: lineProducts[index].id,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              lineTotal: item.quantity * item.unitPrice,
              tenantId: invoiceTenantId
            }))
          }
        }
      });

      await prisma.importedFile.update({
        where: { id: imported.id },
        data: {
          status: 'processed',
          processedAt: new Date(),
          notes: notesWithLogo || effectiveParsed.notes || 'Updated existing invoice'
        }
      });

      return updated;
    }

    const created = await (async () => {
      try {
        return await prisma.invoice.create({
          data: {
            invoiceNo,
            date: invoiceDate,
            dueDate,
            status: 'draft',
            clientId: client.id,
            totalAmount,
            currency,
            sourceFile: imported.fullPath,
            verified: false,
            documentType,
            totalHT,
            timbreFiscal,
            companyName: effectiveParsed.companyName,
            companyEmail: effectiveParsed.companyEmail,
            companyPhone: effectiveParsed.companyPhone,
            paymentTerms: effectiveParsed.paymentTerms,
            taxRate: effectiveParsed.taxRate ?? 0,
            taxAmount: effectiveParsed.taxAmount ?? 0,
            notes: notesWithLogo || effectiveParsed.notes,
            tenantId: invoiceTenantId,
            items: {
              create: effectiveParsed.items.map((item, index) => ({
                productId: lineProducts[index].id,
                description: item.description,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                lineTotal: item.quantity * item.unitPrice,
                tenantId: invoiceTenantId
              }))
            }
          }
        });
      } catch (createErr: unknown) {
        // Handle race condition: another worker created the same invoiceNo concurrently
        const errMsg = createErr instanceof Error ? createErr.message : '';
        if (errMsg.includes('Unique constraint') || (typeof (createErr as { code?: string }).code === 'string' && (createErr as { code: string }).code === 'P2002')) {
          console.log(`[Ingestion] Race condition on invoiceNo "${invoiceNo}" — merging into existing invoice`);
          const raceExisting = await prisma.invoice.findFirst({ where: { invoiceNo }, include: { items: true } });
          if (raceExisting) {
            await prisma.invoiceItem.deleteMany({ where: { invoiceId: raceExisting.id } });
            let mergedSourceFile = imported.fullPath;
            if (raceExisting.sourceFile && raceExisting.sourceFile !== imported.fullPath) {
              const existingSources = raceExisting.sourceFile.split('|').map(s => s.trim()).filter(Boolean);
              if (!existingSources.includes(imported.fullPath)) {
                existingSources.push(imported.fullPath);
              }
              mergedSourceFile = existingSources.join('|');
            }
            return prisma.invoice.update({
              where: { id: raceExisting.id },
              data: {
                date: invoiceDate,
                dueDate,
                clientId: client.id,
                totalAmount,
                currency,
                sourceFile: mergedSourceFile,
                verified: false,
                documentType,
                totalHT,
                timbreFiscal,
                companyName: effectiveParsed.companyName,
                companyEmail: effectiveParsed.companyEmail,
                companyPhone: effectiveParsed.companyPhone,
                paymentTerms: effectiveParsed.paymentTerms,
                taxRate: effectiveParsed.taxRate ?? 0,
                taxAmount: effectiveParsed.taxAmount ?? 0,
                notes: notesWithLogo || effectiveParsed.notes,
                items: {
                  create: effectiveParsed.items.map((item, index) => ({
                    productId: lineProducts[index].id,
                    description: item.description,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    lineTotal: item.quantity * item.unitPrice,
                    tenantId: invoiceTenantId
                  }))
                }
              }
            });
          }
        }
        throw createErr;
      }
    })();

    await prisma.importedFile.update({
      where: { id: imported.id },
      data: {
        status: 'processed',
        processedAt: new Date(),
          notes: notesWithLogo || effectiveParsed.notes || 'Invoice created from file'
      }
    });

    return created;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected ingestion error';
    await prisma.importedFile.update({
      where: { id: imported.id },
      data: {
        status: 'failed',
        processedAt: new Date(),
        notes: message
      }
    });
    throw error;
  }
}

export async function processQueuedFiles(
  limit = 20,
  options?: { drain?: boolean; maxBatches?: number }
) {
  const batchSize = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const drain = options?.drain ?? false;
  const maxBatches = Number.isFinite(options?.maxBatches) && (options?.maxBatches ?? 0) > 0
    ? Math.floor(options!.maxBatches!)
    : 200;

  const concurrency = Number(process.env.INGEST_CONCURRENCY ?? 4);
  const results: Array<{ id: string; ok: boolean; message?: string }> = [];

  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let batches = 0;

  while (true) {
    const queued = await prisma.importedFile.findMany({
      where: { status: 'queued' },
      orderBy: { detectedAt: 'asc' },
      take: batchSize
    });

    if (queued.length === 0) {
      break;
    }

    batches += 1;
    const queue = [...queued];

    async function worker() {
      while (queue.length > 0) {
        const file = queue.shift();
        if (!file) {
          return;
        }

        try {
          await processImportedFile(file.id);
          results.push({ id: file.id, ok: true });
          succeeded += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          results.push({ id: file.id, ok: false, message });
          failed += 1;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
    total += queued.length;

    if (!drain || batches >= maxBatches) {
      break;
    }
  }

  const remainingQueued = await prisma.importedFile.count({ where: { status: 'queued' } });

  return {
    total,
    succeeded,
    failed,
    batches,
    batchSize,
    remainingQueued,
    drained: remainingQueued === 0,
    results
  };
}

async function collectFilesRecursively(folder: string, maxDepth = 12): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string, depth: number) {
    if (depth > maxDepth) {
      return;
    }

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (acceptedExtensions.has(extension)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(folder, 0);
  return files;
}

export async function migrateAllFilesFromFolders(
  folders: string[],
  options?: { processNow?: boolean; includeProcessed?: boolean }
) {
  const processNow = options?.processNow === true;
  const includeProcessed = options?.includeProcessed === true;

  let scanned = 0;
  let queued = 0;
  let skipped = 0;
  let processed = 0;
  let failed = 0;
  const queuedIds: string[] = [];

  for (const folder of folders) {
    const files = await collectFilesRecursively(folder);
    scanned += files.length;

    for (const fullPath of files) {
      const filename = path.basename(fullPath);
      const extension = path.extname(filename).toLowerCase();

      const existing = await prisma.importedFile.findFirst({ where: { fullPath } });
      if (existing && existing.status === 'processed' && !includeProcessed) {
        skipped += 1;
        continue;
      }

      const tenantId = currentTenantId();
      const saved = await prisma.importedFile.upsert({
        where: { tenantId_fullPath: { tenantId, fullPath } },
        update: {
          status: 'queued',
          notes: existing ? 'Re-queued by migrate-all' : 'Queued by migrate-all'
        },
        create: {
          filename,
          fullPath,
          extension,
          status: 'queued',
          notes: 'Queued by migrate-all',
          tenantId
        }
      });

      queued += 1;
      queuedIds.push(saved.id);
    }
  }

  if (processNow) {
    for (const id of queuedIds) {
      try {
        await processImportedFile(id);
        processed += 1;
      } catch {
        failed += 1;
      }
    }
  }

  return {
    folders,
    scanned,
    queued,
    skipped,
    processed,
    failed,
    processNow,
    includeProcessed
  };
}
