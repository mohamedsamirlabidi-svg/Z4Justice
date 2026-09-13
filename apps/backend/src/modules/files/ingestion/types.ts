export type CompanyKind = 'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS' | 'UNKNOWN';

export type RawCellType = 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'empty';

export type RawCell = {
  coordinate: string;
  row: number;
  col: number;
  value: string | number | boolean | null;
  type: RawCellType;
};

export type SheetExtract = {
  sheetName: string;
  headers: string[];
  headerRowIndex: number;
  rows: Array<Record<string, unknown>>;
  allCells: RawCell[];
};

export type InvoiceSummaryLineItem = {
  reference: string;
  quantity: number;
  description: string;
  unitPrice: number;
  totalPrice: number;
  extraLines: string[];
};

export type InvoiceSummary = {
  invoiceNo: string | null;
  date: string | null;
  clientName: string | null;
  clientAddress: string | null;
  country: string | null;
  responsable: string | null;
  consultationRef: string | null;
  totalHT: number | null;
  timbreFiscal: number | null;
  tvaRate: number | null;
  tvaAmount: number | null;
  totalTTC: number | null;
  amountInWords: string | null;
  rib: string | null;
  bank: string | null;
  sellerName: string | null;
  sellerAddress: string | null;
  sellerWebsite: string | null;
  sellerEmail: string | null;
  lineItems: InvoiceSummaryLineItem[];
  companyConfig: {
    companyName: string | null;
    companyAddress: string | null;
    phone: string | null;
    fax: string | null;
  } | null;
};

export type ExtractedFileContent = {
  extension: string;
  fullPath: string;
  filename: string;
  text: string;
  rows: Array<Record<string, string>>;
  allRows?: Array<Record<string, string>>;
  logoImages?: string[];
  sheetNames?: string[];
  perSheet?: SheetExtract[];
  invoiceSummary?: InvoiceSummary;
};

export type ParsedInvoiceItem = {
  name: string;
  description?: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
};

export type ParsedInvoicePayload = {
  company: CompanyKind;
  clientName: string;
  invoiceNo?: string;
  invoiceDate?: Date;
  dueDate?: Date;
  currency?: string;
  items: ParsedInvoiceItem[];
  totalAmount?: number;
  documentType?: 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';
  sourceYear?: number;
  confidence?: 'low' | 'medium' | 'high';
  notes?: string;
  companyName?: string;
  companyEmail?: string;
  companyPhone?: string;
  paymentTerms?: string;
  taxRate?: number;
  taxAmount?: number;
  timbreFiscal?: number;
  totalHT?: number;
  logoUrl?: string;
};
