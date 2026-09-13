import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {
  ExtractedFileContent,
  InvoiceSummary,
  InvoiceSummaryLineItem,
  RawCell,
  RawCellType,
  SheetExtract
} from './types';
import { callFlaskParser, FlaskParserResponse } from './flask-parser-client';

export type ExcelExtractResult = {
  rows: Record<string, unknown>[];
  allRows: Record<string, unknown>[];
  logoImages: string[];
  sheetNames: string[];
  perSheet: SheetExtract[];
  invoiceSummary: InvoiceSummary;
};

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function normalizeCell(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const cleaned = value.replace(/[^0-9,.-]/g, '');
  if (!cleaned) {
    return null;
  }

  const normalized = cleaned.includes(',') && cleaned.includes('.')
    ? cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '')
    : cleaned.includes(',')
      ? cleaned.replace(',', '.')
      : cleaned;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreHeaderCells(cells: string[]): number {
  const headerHints = [
    'designation',
    'désignation',
    'description',
    'libelle',
    'libellé',
    'produit',
    'product',
    'quantite',
    'quantité',
    'qte',
    'qty',
    'pu',
    'prix',
    'price',
    'montant',
    'total',
    'reference',
    'référence'
  ];

  return cells.reduce((score, cell) => {
    const normalized = normalizeKey(cell);
    if (!normalized) {
      return score;
    }

    if (headerHints.some((hint) => normalized.includes(hint))) {
      return score + 2;
    }

    if (/[a-zA-ZÀ-ÿ]/.test(cell) && !/^\d+[.,]?\d*$/.test(cell)) {
      return score + 1;
    }

    return score;
  }, 0);
}

function expandMergedCells(ws: XLSX.WorkSheet): void {
  const merges = ws['!merges'] || [];
  for (const merge of merges) {
    const topLeftAddr = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    const topLeftCell = ws[topLeftAddr];
    if (!topLeftCell) continue;

    for (let r = merge.s.r; r <= merge.e.r; r += 1) {
      for (let c = merge.s.c; c <= merge.e.c; c += 1) {
        if (r === merge.s.r && c === merge.s.c) continue;
        const addr = XLSX.utils.encode_cell({ r, c });
        ws[addr] = { ...topLeftCell };
      }
    }
  }
}

function getCellValue(cell: XLSX.CellObject | undefined): { value: string | number | boolean | null; type: RawCellType } {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') {
    return { value: null, type: 'empty' };
  }

  if (cell.f !== undefined) {
    if (typeof cell.v === 'number') return { value: cell.v, type: 'formula' };
    if (typeof cell.v === 'boolean') return { value: cell.v, type: 'formula' };
    return { value: String(cell.v).trim(), type: 'formula' };
  }

  switch (cell.t) {
    case 'n':
      return { value: cell.v as number, type: 'number' };
    case 'b':
      return { value: cell.v as boolean, type: 'boolean' };
    case 'd': {
      const value = cell.v as Date | string;
      const date = value instanceof Date ? value : new Date(String(value));
      return { value: Number.isNaN(date.getTime()) ? String(value) : date.toISOString(), type: 'date' };
    }
    case 's':
    default:
      return { value: String(cell.v).trim(), type: 'string' };
  }
}

function detectHeaderRow(ws: XLSX.WorkSheet, range: XLSX.Range): number {
  const limit = Math.min(range.s.r + 15, range.e.r);
  let bestRow = range.s.r;
  let bestCount = 0;

  for (let r = range.s.r; r <= limit; r += 1) {
    let count = 0;
    const rowCells: string[] = [];

    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const { value } = getCellValue(ws[addr]);
      rowCells.push(value === null ? '' : String(value));
      if (value !== null && String(value).trim() !== '') {
        count += 1;
      }
    }

    const weighted = count + scoreHeaderCells(rowCells);
    if (weighted > bestCount) {
      bestCount = weighted;
      bestRow = r;
    }
  }

  return bestRow;
}

function extractAllCells(ws: XLSX.WorkSheet): RawCell[] {
  const ref = ws['!ref'];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);
  const cells: RawCell[] = [];

  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const coordinate = XLSX.utils.encode_cell({ r, c });
      const { value, type } = getCellValue(ws[coordinate]);
      if (type !== 'empty') {
        cells.push({ coordinate, row: r + 1, col: c + 1, value, type });
      }
    }
  }

  return cells;
}

function extractRows(ws: XLSX.WorkSheet, range: XLSX.Range, headerRowIdx: number): { headers: string[]; rows: Record<string, unknown>[] } {
  const headers: string[] = [];

  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIdx, c });
    const { value } = getCellValue(ws[addr]);
    headers.push(value !== null ? String(value) : `col_${c + 1}`);
  }

  const rows: Record<string, unknown>[] = [];

  for (let r = headerRowIdx + 1; r <= range.e.r; r += 1) {
    const row: Record<string, unknown> = {};
    let hasValue = false;

    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const { value } = getCellValue(ws[addr]);
      if (value !== null) {
        hasValue = true;
      }
      const headerKey = headers[c - range.s.c] || `col_${c + 1}`;
      row[headerKey] = value;
    }

    if (hasValue) {
      rows.push(row);
    }
  }

  return { headers, rows };
}

function extractInvoiceSheet(ws: XLSX.WorkSheet) {
  const g = (addr: string) => getCellValue(ws[addr]).value;

  const invoiceRaw = g('J18');
  const invoiceNo = typeof invoiceRaw === 'string'
    ? ((invoiceRaw.match(/(\d{4}-\d+)/) ?? [])[1] || invoiceRaw.trim() || null)
    : null;

  const dateRaw = g('J22');
  let date: string | null = null;
  if (typeof dateRaw === 'string') {
    const match = dateRaw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (match) {
      date = `${match[3]}-${match[2]}-${match[1]}`;
    }
  }

  const respRaw = typeof g('J24') === 'string' ? (g('J24') as string) : '';
  const responsable = respRaw.replace(/^Responsable:/i, '').trim() || null;

  const lineItems: InvoiceSummaryLineItem[] = [];
  const ref = ws['!ref'];
  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    let currentItem: InvoiceSummaryLineItem | null = null;

    for (let r = 27; r <= Math.min(range.e.r, 59); r += 1) {
      const refVal = g(XLSX.utils.encode_cell({ r, c: 1 }));
      const qtyVal = g(XLSX.utils.encode_cell({ r, c: 2 }));
      const descVal = g(XLSX.utils.encode_cell({ r, c: 3 }));
      const puVal = g(XLSX.utils.encode_cell({ r, c: 9 }));
      const montVal = g(XLSX.utils.encode_cell({ r, c: 10 }));

      if (typeof qtyVal === 'number' && typeof puVal === 'number') {
        currentItem = {
          reference: String(refVal ?? '').trim(),
          quantity: qtyVal,
          description: String(descVal ?? '').trim(),
          unitPrice: puVal,
          totalPrice: typeof montVal === 'number' ? montVal : puVal * qtyVal,
          extraLines: []
        };
        lineItems.push(currentItem);
      } else if (
        currentItem &&
        typeof descVal === 'string' &&
        descVal.trim() &&
        !refVal && !qtyVal && !puVal && !montVal
      ) {
        currentItem.extraLines.push(descVal.trim());
      }
    }
  }

  return {
    invoiceNo,
    date,
    clientName: normalizeCell(g('C22')) || null,
    clientAddress: normalizeCell(g('C23')) || null,
    country: normalizeCell(g('H24')) || null,
    responsable,
    consultationRef: normalizeCell(g('J25')) || null,
    totalHT: toNumber(g('K43')),
    timbreFiscal: toNumber(g('K44')),
    tvaRate: toNumber(g('J45')),
    tvaAmount: toNumber(g('K45')),
    totalTTC: toNumber(g('K46')),
    amountInWords: normalizeCell(g('A43')).replace(/^\s+/, '') || null,
    rib: normalizeCell(g('B53')).replace(/^RIB:\s*/i, '') || null,
    bank: normalizeCell(g('B54')) || null,
    sellerAddress: normalizeCell(g('B56')) || null,
    sellerWebsite: normalizeCell(g('B58')).replace(/^Site web:\s*/i, '') || null,
    sellerEmail: normalizeCell(g('C60')).replace(/^MAIL:\s*/i, '') || null,
    lineItems
  };
}

function extractCompanyConfigSheet(ws: XLSX.WorkSheet) {
  const g = (addr: string) => getCellValue(ws[addr]).value;
  return {
    companyName: normalizeCell(g('E12')) || null,
    companyAddress: normalizeCell(g('E13')) || null,
    phone: normalizeCell(g('E14')) || null,
    fax: normalizeCell(g('E15')) || null
  };
}

async function extractXlsxImageNames(filePath: string): Promise<string[]> {
  if (path.extname(filePath).toLowerCase() !== '.xlsx') {
    return [];
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(fileBuffer);
    return Object.keys(zip.files)
      .filter((name) => name.startsWith('xl/media/'))
      .map((name) => name.replace('xl/media/', ''));
  } catch {
    return [];
  }
}

export async function extractExcel(filePath: string): Promise<ExcelExtractResult> {
  const workbook = XLSX.readFile(filePath, {
    type: 'file',
    cellDates: true,
    cellFormula: true,
    sheetStubs: false
  });

  const allFlatRows: Record<string, unknown>[] = [];
  const allFlatAllRows: Record<string, unknown>[] = [];
  const perSheet: SheetExtract[] = [];

  let invoiceSheetExtract: ReturnType<typeof extractInvoiceSheet> | null = null;
  let companyConfig: ReturnType<typeof extractCompanyConfigSheet> | null = null;

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;

    expandMergedCells(ws);

    const range = XLSX.utils.decode_range(ws['!ref']);
    const headerRowIdx = detectHeaderRow(ws, range);
    const { headers, rows } = extractRows(ws, range, headerRowIdx);
    const allCells = extractAllCells(ws);

    perSheet.push({
      sheetName,
      headers,
      headerRowIndex: headerRowIdx + 1,
      rows,
      allCells
    });

    allFlatRows.push(...rows.map((row) => ({ ...row, _sheet: sheetName })));
    allFlatAllRows.push(...allCells.map((cell) => ({ sheet: sheetName, ...cell })));

    if (sheetName === 'Facture') {
      invoiceSheetExtract = extractInvoiceSheet(ws);
    }

    if (sheetName === 'Personnaliser votre facture') {
      companyConfig = extractCompanyConfigSheet(ws);
    }
  }

  const logoImages = await extractXlsxImageNames(filePath);

  const invoiceSummary: InvoiceSummary = {
    invoiceNo: null,
    date: null,
    clientName: null,
    clientAddress: null,
    country: null,
    responsable: null,
    consultationRef: null,
    totalHT: null,
    timbreFiscal: null,
    tvaRate: null,
    tvaAmount: null,
    totalTTC: null,
    amountInWords: null,
    rib: null,
    bank: null,
    sellerName: companyConfig?.companyName ?? null,
    sellerAddress: null,
    sellerWebsite: null,
    sellerEmail: null,
    lineItems: [],
    companyConfig: companyConfig ?? null,
    ...(invoiceSheetExtract ?? {})
  };

  return {
    rows: allFlatRows,
    allRows: allFlatAllRows,
    logoImages,
    sheetNames: workbook.SheetNames,
    perSheet,
    invoiceSummary
  };
}

function toStringRecord(input: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = value === null || value === undefined ? '' : String(value);
  }
  return output;
}

export async function extractFileContent(fullPath: string): Promise<ExtractedFileContent> {
  const filename = path.basename(fullPath);
  const extension = path.extname(filename).toLowerCase();

  if (extension === '.pdf') {
    const data = await fsp.readFile(fullPath);
    const parsed = await pdfParse(data);
    return {
      extension,
      fullPath,
      filename,
      text: parsed.text ?? '',
      rows: [],
      allRows: [],
      logoImages: [],
      sheetNames: [],
      perSheet: [],
      invoiceSummary: undefined
    };
  }

  if (extension === '.xls' || extension === '.xlsx') {
    const excel = await extractExcel(fullPath);

    const text = [
      ...excel.rows.map((row) => Object.values(row).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').join(' | ')),
      ...excel.allRows.map((row) =>
        Object.entries(row)
          .filter(([key]) => key.startsWith('column_'))
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
          .map(([, value]) => (value === null || value === undefined ? '' : String(value)))
          .filter((value) => value.trim().length > 0)
          .join(' | ')
      )
    ]
      .filter(Boolean)
      .join('\n');

    return {
      extension,
      fullPath,
      filename,
      text,
      rows: excel.rows.map((row) => toStringRecord(row)),
      allRows: excel.allRows.map((row) => toStringRecord(row)),
      logoImages: excel.logoImages,
      sheetNames: excel.sheetNames,
      perSheet: excel.perSheet,
      invoiceSummary: excel.invoiceSummary
    };
  }

  if (extension === '.csv') {
    const raw = await fsp.readFile(fullPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const [headerLine = '', ...body] = lines;
    const headers = headerLine.split(',').map((value, index) => normalizeKey(value) || `column_${index + 1}`);

    const rows = body.map((line) => {
      const cells = line.split(',').map((cell) => normalizeCell(cell));
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] ?? '';
      });
      return record;
    });

    return {
      extension,
      fullPath,
      filename,
      text: lines.join('\n'),
      rows,
      allRows: rows,
      logoImages: [],
      sheetNames: ['csv'],
      perSheet: [],
      invoiceSummary: undefined
    };
  }

  throw new Error(`Unsupported file extension: ${extension}`);
}

/**
 * Extract file content with optional Flask parser enhancement.
 *
 * Tries Flask parser first for improved extraction quality.
 * Falls back to TypeScript extraction if Flask parser is unavailable.
 */
export async function extractFileContentWithFlaskParser(fullPath: string): Promise<ExtractedFileContent & { flaskParserData?: FlaskParserResponse }> {
  const extension = path.extname(fullPath).toLowerCase();

  // Try Flask parser first for PDF and Excel files
  if (extension === '.pdf' || extension === '.xlsx' || extension === '.xls') {
    const flaskResult = await callFlaskParser(fullPath);

    if (flaskResult) {
      // Flask parser succeeded - merge with TypeScript extraction for complete data
      const tsExtraction = await extractFileContent(fullPath);

      return {
        ...tsExtraction,
        flaskParserData: flaskResult
      };
    }
  }

  // Fallback to TypeScript extraction
  return extractFileContent(fullPath);
}
