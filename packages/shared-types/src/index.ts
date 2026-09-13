export type CompanyContext = 'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS';

export interface ClientDto {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
}

export interface ProductDto {
  id: string;
  sku?: string;
  name: string;
  description?: string;
  unitPrice: number;
}

export interface InvoiceItemDto {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceDto {
  id: string;
  invoiceNo: string;
  clientId: string;
  date: string;
  dueDate?: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue';
  currency: string;
  totalAmount: number;
}

export interface ImportedFileDto {
  id: string;
  filename: string;
  fullPath: string;
  extension: string;
  status: 'queued' | 'processing' | 'processed' | 'failed';
}
