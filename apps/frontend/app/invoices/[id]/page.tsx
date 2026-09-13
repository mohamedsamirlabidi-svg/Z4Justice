'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { getDemoInvoiceById } from '../../lib/demoInvoices';
import { useAuth } from '../../lib/auth';
import { formatTND, formatDate, display, statusClass, normalizeTaxRate } from '../../lib/format';

type InvoiceItem = {
  id: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  product?: {
    id?: string;
    name: string;
    sku?: string | null;
    description?: string | null;
  };
};

type EditableInvoiceItem = {
  id: string;
  productId?: string;
  sku?: string;
  description: string;
  quantity: string;
  unitPrice: string;
};

type InvoiceDetail = {
  id: string;
  invoiceNo: string;
  date: string;
  dueDate?: string | null;
  status: string;
  currency: string;
  totalAmount: number;
  verified?: boolean;
  totalHT?: number | null;
  taxRate?: number | null;
  taxAmount?: number | null;
  timbreFiscal?: number | null;
  orderNo?: string | null;
  sourceFile?: string | null;
  documentType?: 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';
  companyName?: string | null;
  companyEmail?: string | null;
  companyPhone?: string | null;
  paymentTerms?: string | null;
  sellerAddress?: string | null;
  sellerWebsite?: string | null;
  rib?: string | null;
  bank?: string | null;
  consultationRef?: string | null;
  responsable?: string | null;
  amountInWords?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
  client?: {
    id: string;
    name: string;
    company?: string | null;
    address?: string | null;
    city?: string | null;
    taxId?: string | null;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  items: InvoiceItem[];
};

type InvoiceEditForm = {
  invoiceNo: string;
  date: string;
  dueDate: string;
  status: string;
  verified: boolean;
  currency: string;
  totalAmount: string;
  totalHT: string;
  taxRate: string;
  taxAmount: string;
  timbreFiscal: string;
  orderNo: string;
  paymentTerms: string;
  bank: string;
  rib: string;
  companyName: string;
  companyEmail: string;
  companyPhone: string;
  sellerAddress: string;
  sellerWebsite: string;
  consultationRef: string;
  responsable: string;
  amountInWords: string;
  notes: string;
  clientName: string;
  clientPhone: string;
  clientAddress: string;
  clientCity: string;
  clientTaxId: string;
  clientContactName: string;
};

const EDITABLE_STATUSES = ['draft', 'pending', 'sent', 'paid', 'overdue', 'verified'] as const;
const PAYMENT_TERMS_OPTIONS = ['Par chèque', 'Virement', 'Espèce'] as const;

function toDateInputValue(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function toNumberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function getIssuerProfile(company?: string | null) {
  if (company === 'GAMESTREAM_ATLAS' || (company && company.toLowerCase().includes('gamestream'))) {
    return { legalName: 'GameStream ATLAS' };
  }
  return {
    legalName: 'Acrobate Solution',
    bank: 'STB THAMEUR',
    rib: '10 000 000 080746 3788 95'
  };
}

function getFileNameOnly(fullPath?: string | null) {
  if (!fullPath) return '-';
  const normalized = fullPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || fullPath;
}

function parseMetadataFromNotes(notes?: string | null): Record<string, unknown> | null {
  if (!notes) return null;
  const parts = notes
    .split(' | ')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (!(part.startsWith('{') && part.endsWith('}'))) continue;
    try {
      const parsed = JSON.parse(part) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  return null;
}

function buildNotesWithMetadata(notes: string | undefined, metadata: Record<string, unknown>): string | undefined {
  const parts = (notes ?? '')
    .split(' | ')
    .map((part) => part.trim())
    .filter(Boolean);

  const nonJsonParts = parts.filter((part) => !(part.startsWith('{') && part.endsWith('}')));
  const cleanedMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => {
      if (typeof value === 'string') return value.trim().length > 0;
      return value !== null && value !== undefined;
    })
  );

  const finalParts = [...nonJsonParts];
  if (Object.keys(cleanedMetadata).length > 0) {
    finalParts.push(JSON.stringify(cleanedMetadata));
  }

  const finalNotes = finalParts.join(' | ');
  return finalNotes.trim().length > 0 ? finalNotes : undefined;
}

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const invoiceId = params?.id;
  const demoInvoice = useMemo(() => getDemoInvoiceById(invoiceId), [invoiceId]);
  const isDemoInvoice = Boolean(demoInvoice);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<InvoiceEditForm | null>(null);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [editItems, setEditItems] = useState<EditableInvoiceItem[] | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  async function loadInvoice() {
    if (!invoiceId) return;
    setBusy(true);
    setError('');
    try {
      if (demoInvoice) {
        setInvoice(demoInvoice as unknown as InvoiceDetail);
        return;
      }
      const data = await apiRequest<InvoiceDetail>(`/invoices/${invoiceId}`);
      setInvoice(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoice detail');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadInvoice();
  }, [invoiceId]);

  function startEditing() {
    if (!invoice) return;

    const meta = parseMetadataFromNotes(invoice.notes);

    setEditForm({
      invoiceNo: invoice.invoiceNo ?? '',
      date: toDateInputValue(invoice.date),
      dueDate: toDateInputValue(invoice.dueDate),
      status: (invoice.status ?? 'pending').toLowerCase(),
      verified: Boolean(invoice.verified),
      currency: invoice.currency ?? 'TND',
      totalAmount: String(invoice.totalAmount ?? ''),
      totalHT: String(invoice.totalHT ?? ''),
      taxRate: String(invoice.taxRate ?? ''),
      taxAmount: String(invoice.taxAmount ?? ''),
      timbreFiscal: String(invoice.timbreFiscal ?? ''),
      orderNo: invoice.orderNo ?? '',
      paymentTerms: invoice.paymentTerms ?? '',
      bank: invoice.bank ?? '',
      rib: invoice.rib ?? '',
      companyName: invoice.companyName ?? '',
      companyEmail: invoice.companyEmail ?? '',
      companyPhone: invoice.companyPhone ?? '',
      sellerAddress: invoice.sellerAddress ?? '',
      sellerWebsite: invoice.sellerWebsite ?? '',
      consultationRef: invoice.consultationRef ?? '',
      responsable: invoice.responsable ?? '',
      amountInWords: invoice.amountInWords ?? '',
      notes: invoice.notes ?? '',
      clientName: invoice.client?.name ?? '',
      clientPhone: invoice.client?.phone ?? '',
      clientAddress: ((invoice.client?.address as string | undefined) || (meta?.clientAddress as string | undefined) || ''),
      clientCity: ((invoice.client?.city as string | undefined) || (meta?.clientCity as string | undefined) || ''),
      clientTaxId: ((invoice.client?.taxId as string | undefined) || (meta?.clientTaxId as string | undefined) || ''),
      clientContactName: ((invoice.client?.contactName as string | undefined) || (meta?.clientContactName as string | undefined) || invoice.responsable || ''),
    });
    setSaveMessage('');
    setSaveError('');
    setActiveField(null);
    setEditItems(
      invoice.items.map((item) => ({
        id: item.id,
        productId: item.product?.id,
        sku: item.product?.sku ?? undefined,
        description: item.description ?? item.product?.name ?? '',
        quantity: String(item.quantity ?? ''),
        unitPrice: String(item.unitPrice ?? ''),
      }))
    );
    setIsEditing(true);
  }

  async function saveInvoiceChanges(markAsVerified = false) {
    if (isDemoInvoice) {
      setSaveMessage('Demo invoices are read-only for recording.');
      return;
    }

    if (!invoice || !editForm || !isAdmin) return;

    if (markAsVerified) {
      const confirmed = window.confirm('Confirm status change from pending to verified and save all changes?');
      if (!confirmed) return;
    }

    setSaveBusy(true);
    setSaveError('');
    setSaveMessage('');

    try {
      const normalizedStatus = markAsVerified
        ? 'verified'
        : (editForm.status.trim().toLowerCase() || 'pending');

      const normalizedItems = (editItems ?? []).map((item) => {
        const quantity = toNumberOrUndefined(item.quantity) ?? 0;
        const unitPrice = toNumberOrUndefined(item.unitPrice) ?? 0;
        return {
          productId: item.productId,
          sku: item.sku,
          description: item.description,
          quantity,
          unitPrice,
          totalPrice: quantity * unitPrice,
        };
      });

      const baseMeta = parseMetadataFromNotes(invoice.notes) ?? {};
      const mergedNotes = buildNotesWithMetadata(editForm.notes || invoice.notes || undefined, {
        ...baseMeta,
        clientAddress: editForm.clientAddress,
        clientCity: editForm.clientCity,
        clientTaxId: editForm.clientTaxId,
        clientContactName: editForm.clientContactName,
      });

      const updatedInvoice = await apiRequest<InvoiceDetail>(`/invoices/${invoice.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          invoiceNo: editForm.invoiceNo,
          date: editForm.date || undefined,
          dueDate: editForm.dueDate || null,
          status: normalizedStatus,
          verified: markAsVerified ? true : editForm.verified,
          currency: editForm.currency,
          totalAmount: toNumberOrUndefined(editForm.totalAmount),
          totalHT: toNumberOrUndefined(editForm.totalHT),
          taxRate: toNumberOrUndefined(editForm.taxRate),
          taxAmount: toNumberOrUndefined(editForm.taxAmount),
          timbreFiscal: toNumberOrUndefined(editForm.timbreFiscal),
          orderNo: editForm.orderNo,
          paymentTerms: editForm.paymentTerms,
          bank: editForm.bank,
          rib: editForm.rib,
          companyName: editForm.companyName,
          companyEmail: editForm.companyEmail,
          companyPhone: editForm.companyPhone,
          sellerAddress: editForm.sellerAddress,
          sellerWebsite: editForm.sellerWebsite,
          consultationRef: editForm.consultationRef,
          responsable: editForm.responsable,
          contactName: editForm.responsable,
          amountInWords: editForm.amountInWords,
          notes: mergedNotes,
          client: {
            name: editForm.clientName,
            phone: editForm.clientPhone,
          },
          ...(editItems ? { items: normalizedItems } : {}),
        }),
      });

      setInvoice(updatedInvoice);
      setIsEditing(false);
      setActiveField(null);
      setEditForm(null);
      setEditItems(null);
      setSaveMessage(markAsVerified ? 'Invoice updated and verified successfully.' : 'Invoice updated successfully.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save invoice changes');
    } finally {
      setSaveBusy(false);
    }
  }

  const subtotal = useMemo(() => {
    if (isEditing && editItems) {
      return editItems.reduce((sum, item) => {
        const quantity = toNumberOrUndefined(item.quantity) ?? 0;
        const unitPrice = toNumberOrUndefined(item.unitPrice) ?? 0;
        return sum + (quantity * unitPrice);
      }, 0);
    }
    return (invoice?.items ?? []).reduce((sum, item) => sum + item.lineTotal, 0);
  }, [invoice, isEditing, editItems]);

  const extractedMeta = useMemo(() => parseMetadataFromNotes(invoice?.notes), [invoice?.notes]);
  const normalizedTaxRate = useMemo(() => {
    if (isEditing && editForm) {
      const rawTax = toNumberOrUndefined(editForm.taxRate);
      if (rawTax !== undefined) return normalizeTaxRate(rawTax);
    }
    return normalizeTaxRate(invoice?.taxRate);
  }, [invoice?.taxRate, isEditing, editForm]);
  const issuer = useMemo(() => getIssuerProfile(invoice?.client?.company ?? invoice?.companyName), [invoice?.client?.company, invoice?.companyName]);

  const taxableBase = useMemo(() => {
    if (!invoice) return 0;
    // Use totalHT if available, otherwise compute from items
    if (invoice.totalHT && invoice.totalHT > 0) return invoice.totalHT;
    if (subtotal > 0) return subtotal;
    const fallback = Number(invoice.totalAmount || 0) - Number(invoice.taxAmount || 0) - Number(invoice.timbreFiscal || 0);
    return Math.max(0, fallback);
  }, [invoice, subtotal]);

  const dataChecks = useMemo(() => {
    if (!invoice) return [] as string[];
    const checks: string[] = [];
    if (!invoice.client?.name) checks.push('Missing client name');
    if (!invoice.sourceFile) checks.push('Missing source file path');
    if (invoice.totalAmount <= 0) checks.push('Total amount is zero or negative');
    if (invoice.verified === false) checks.push('Invoice has not been verified by rescan yet');
    return checks;
  }, [invoice]);

  const documentLabel = useMemo(() => {
    if (invoice?.documentType === 'bon_de_livraison') return 'BON DE LIVRAISON';
    if (invoice?.documentType === 'devis') return 'DEVIS';
    return 'FACTURE';
  }, [invoice?.documentType]);

  const clientAddress =
    (invoice?.client?.address as string | undefined) ||
    (extractedMeta?.clientAddress as string | undefined) ||
    '-';
  const clientCity =
    (invoice?.client?.city as string | undefined) ||
    (extractedMeta?.clientCity as string | undefined) ||
    '-';
  const clientTaxId =
    (invoice?.client?.taxId as string | undefined) ||
    (extractedMeta?.clientTaxId as string | undefined) ||
    '-';
  const clientContact =
    (invoice?.client?.contactName as string | undefined) ||
    (extractedMeta?.clientContactName as string | undefined) ||
    invoice?.responsable ||
    '-';

  const inlineEnabled = Boolean(isAdmin && isEditing && editForm);
  const canEditInvoice = Boolean(isAdmin && invoice && !isDemoInvoice);
  const currentOrderNo = (inlineEnabled ? editForm?.orderNo : invoice?.orderNo) ?? '';
  const hasOrderNoForPrint = currentOrderNo.trim().length > 0 && currentOrderNo.trim() !== '-';

  function updateEditField<K extends keyof InvoiceEditForm>(field: K, value: InvoiceEditForm[K]) {
    if (!editForm) return;
    setEditForm({ ...editForm, [field]: value });
  }

  function inlineText(field: keyof InvoiceEditForm, fallback?: string | null) {
    const value = editForm?.[field];
    const textValue = typeof value === 'string' ? value : '';
    const finalText = textValue || fallback || '';

    if (!inlineEnabled) return display(fallback);

    const fieldKey = `field:${String(field)}`;

    if (activeField === fieldKey) {
      return (
        <input
          className="input no-print"
          autoFocus
          value={textValue}
          onChange={(e) => updateEditField(field, e.target.value)}
          onBlur={() => setActiveField(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') setActiveField(null);
          }}
          style={{ width: '100%', maxWidth: 320, display: 'inline-block' }}
        />
      );
    }

    return (
      <span
        onClick={() => setActiveField(fieldKey)}
        title="Click to edit"
        style={{ cursor: 'text', borderBottom: '1px dashed #94a3b8', paddingBottom: 1 }}
      >
        {display(finalText)}
      </span>
    );
  }

  function inlineDate(field: keyof InvoiceEditForm, fallbackIso?: string | null) {
    if (!inlineEnabled) return formatDate(fallbackIso);

    const value = String(editForm?.[field] ?? '');
    const fieldKey = `field:${String(field)}`;

    if (activeField === fieldKey) {
      return (
        <input
          className="input no-print"
          type="date"
          autoFocus
          value={value}
          onChange={(e) => updateEditField(field, e.target.value)}
          onBlur={() => setActiveField(null)}
          style={{ width: 170, display: 'inline-block' }}
        />
      );
    }

    return (
      <span
        onClick={() => setActiveField(fieldKey)}
        title="Click to edit"
        style={{ cursor: 'text', borderBottom: '1px dashed #94a3b8', paddingBottom: 1 }}
      >
        {value ? formatDate(value) : formatDate(fallbackIso)}
      </span>
    );
  }

  function inlineMoney(field: keyof InvoiceEditForm, fallbackAmount: number) {
    if (!inlineEnabled) return formatTND(fallbackAmount);

    const value = String(editForm?.[field] ?? '');
    const parsed = toNumberOrUndefined(value);
    const fieldKey = `field:${String(field)}`;

    if (activeField === fieldKey) {
      return (
        <input
          className="input no-print"
          type="number"
          step="0.001"
          autoFocus
          value={value}
          onChange={(e) => updateEditField(field, e.target.value)}
          onBlur={() => setActiveField(null)}
          style={{ width: 150, display: 'inline-block', textAlign: 'right' }}
        />
      );
    }

    return (
      <span
        onClick={() => setActiveField(fieldKey)}
        title="Click to edit"
        style={{ cursor: 'text', borderBottom: '1px dashed #94a3b8', paddingBottom: 1 }}
      >
        {formatTND(parsed ?? fallbackAmount)}
      </span>
    );
  }

  function inlinePercent(field: keyof InvoiceEditForm, fallbackRate: number) {
    if (!inlineEnabled) return `${(fallbackRate * 100).toFixed(0)}%`;

    const value = String(editForm?.[field] ?? '');
    const parsed = toNumberOrUndefined(value);
    const normalized = parsed !== undefined ? normalizeTaxRate(parsed) : fallbackRate;

    const fieldKey = `field:${String(field)}`;

    if (activeField === fieldKey) {
      return (
        <input
          className="input no-print"
          type="number"
          step="0.01"
          autoFocus
          value={value}
          onChange={(e) => updateEditField(field, e.target.value)}
          onBlur={() => setActiveField(null)}
          style={{ width: 90, display: 'inline-block', textAlign: 'right' }}
        />
      );
    }

    return (
      <span
        onClick={() => setActiveField(fieldKey)}
        title="Click to edit"
        style={{ cursor: 'text', borderBottom: '1px dashed #94a3b8', paddingBottom: 1 }}
      >
        {(normalized * 100).toFixed(0)}%
      </span>
    );
  }

  function inlinePaymentTerms(fallback?: string | null) {
    if (!inlineEnabled) return display(fallback);

    return (
      <select
        className="select no-print"
        value={editForm?.paymentTerms ?? ''}
        onChange={(e) => updateEditField('paymentTerms', e.target.value)}
        style={{ minWidth: 180 }}
      >
        <option value="">-</option>
        {PAYMENT_TERMS_OPTIONS.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }

  function updateEditItem(index: number, field: keyof EditableInvoiceItem, value: string) {
    if (!editItems) return;
    const next = [...editItems];
    next[index] = { ...next[index], [field]: value };
    setEditItems(next);
  }

  function inlineItemValue(index: number, field: keyof EditableInvoiceItem, fallback: string, opts?: { numeric?: boolean; alignRight?: boolean; width?: number }) {
    const key = `item:${index}:${String(field)}`;
    const value = editItems?.[index]?.[field];
    const textValue = typeof value === 'string' ? value : fallback;

    if (!inlineEnabled) return fallback;

    if (activeField === key) {
      return (
        <input
          className="input no-print"
          autoFocus
          type={opts?.numeric ? 'number' : 'text'}
          step={opts?.numeric ? '0.001' : undefined}
          value={textValue}
          onChange={(e) => updateEditItem(index, field, e.target.value)}
          onBlur={() => setActiveField(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') setActiveField(null);
          }}
          style={{ width: opts?.width ?? 120, display: 'inline-block', textAlign: opts?.alignRight ? 'right' : 'left' }}
        />
      );
    }

    return (
      <span
        onClick={() => setActiveField(key)}
        title="Click to edit"
        style={{ cursor: 'text', borderBottom: '1px dashed #94a3b8', paddingBottom: 1 }}
      >
        {textValue || '-'}
      </span>
    );
  }

  return (
    <main style={{ maxWidth: 1020, margin: '0 auto', padding: '1.5rem' }}>
      <style jsx global>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          .no-print { display: none !important; }
          .app-sidebar,
          .app-topbar,
          .sidebar-overlay,
          .mobile-menu-btn,
          .app-brand,
          .app-nav,
          .sidebar-footer {
            display: none !important;
          }
          .app-shell,
          .app-main,
          .app-content {
            margin: 0 !important;
            padding: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
          }
          body { background: #fff !important; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          main { max-width: 100% !important; margin: 0 !important; padding: 0 !important; }
          .print-card { border: 0 !important; box-shadow: none !important; border-radius: 0 !important; padding: 0 !important; margin: 0 !important; }
        }
      `}</style>

      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Link href="/invoices" style={{ textDecoration: 'none', color: 'var(--color-primary-light)', fontWeight: 500 }}>
          ← Back to invoices
        </Link>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEditInvoice && !isEditing ? (
            <button className="button" onClick={startEditing}>
              ✏️ Inline edit
            </button>
          ) : null}
          {canEditInvoice && isEditing ? (
            <>
              <button className="button button-primary" disabled={saveBusy} onClick={() => void saveInvoiceChanges(false)}>
                {saveBusy ? 'Saving…' : 'Save changes'}
              </button>
              <button className="button" disabled={saveBusy} onClick={() => void saveInvoiceChanges(true)}>
                ✅ Confirm pending → verified
              </button>
              <button className="button" disabled={saveBusy} onClick={() => { setIsEditing(false); setEditForm(null); setEditItems(null); setActiveField(null); }}>
                Cancel
              </button>
            </>
          ) : null}
          <button
            className="button button-primary"
            onClick={() => window.print()}
          >
            🖨 Print {documentLabel.toLowerCase()}
          </button>
        </div>
      </div>

      {saveMessage ? <p className="no-print" style={{ color: 'var(--color-success)', fontSize: 13 }}>{saveMessage}</p> : null}
      {saveError ? <p className="no-print" style={{ color: 'var(--color-danger)', fontSize: 13 }}>{saveError}</p> : null}
      {isDemoInvoice ? (
        <div className="no-print card" style={{ marginBottom: 14, padding: '12px 16px', background: 'var(--color-primary-soft)' }}>
          <strong style={{ fontSize: 13 }}>Demo invoice:</strong>{' '}
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            this record is served from the frontend static dataset, so it opens instantly without calling Prisma.
          </span>
        </div>
      ) : null}

      {busy ? <p>Loading invoice…</p> : null}
      {error ? <p style={{ color: 'var(--color-danger)' }}>{error}</p> : null}

      {invoice ? (
        <article
          className="print-card card"
          style={{ padding: '2rem' }}
        >
          {/* Header */}
          <header style={{ marginBottom: 20, borderBottom: '2px solid var(--color-primary)', paddingBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 16, alignItems: 'start' }}>
              <div style={{ minHeight: 96 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/acrobate.png"
                  alt="Acrobate Solution"
                  style={{ height: 60, objectFit: 'contain', display: 'block', marginBottom: 8 }}
                />
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                  <div>4 RUE DU CAIRE 1001 TUNIS</div>
                  <div>Tél : (216).71 258 108</div>
                  <div>Fax : (216).71 259 346</div>
                  <div>RC : B161701999</div>
                  <div>MF : 645 267 KMA 000</div>
                </div>
              </div>

              <div style={{ textAlign: 'center', minWidth: 280, alignSelf: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 1, color: 'var(--color-primary)' }}>{documentLabel}</div>
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                    <strong>N° Facture:</strong> {inlineText('invoiceNo', invoice.invoiceNo)}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                    <strong>Date:</strong> {inlineDate('date', invoice.date)}
                  </div>
                  <div className={hasOrderNoForPrint ? undefined : 'no-print'} style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                    <strong>N° Commande:</strong> {inlineText('orderNo', invoice.orderNo)}
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  {inlineEnabled ? (
                    <select
                      className="select no-print"
                      value={editForm?.status ?? 'pending'}
                      onChange={(e) => updateEditField('status', e.target.value)}
                      style={{ fontSize: 12, padding: '2px 8px' }}
                    >
                      {EDITABLE_STATUSES.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={`no-print ${statusClass(invoice.status)}`}>
                      {invoice.status}
                    </span>
                  )}
                  <span
                    className="no-print"
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      borderRadius: 999,
                      padding: '2px 8px',
                      border: '1px solid var(--color-border)',
                      color: (inlineEnabled ? editForm?.verified : invoice.verified) ? 'var(--color-success)' : 'var(--color-text-muted)',
                      background: (inlineEnabled ? editForm?.verified : invoice.verified) ? '#ecfdf3' : '#f8fafc',
                      cursor: inlineEnabled ? 'pointer' : 'default'
                    }}
                    onClick={() => {
                      if (!inlineEnabled || !editForm) return;
                      updateEditField('verified', !editForm.verified);
                    }}
                  >
                    {(inlineEnabled ? editForm?.verified : invoice.verified) ? 'Verified' : 'Unverified'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/miguel.png"
                    alt="Miguel"
                    style={{ height: 40, objectFit: 'contain', display: 'block' }}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/fallprotec.png"
                    alt="Fallprotec"
                    style={{ height: 40, objectFit: 'contain', display: 'block' }}
                  />
                </div>
              </div>
            </div>
          </header>

          {/* Client & Payment Info */}
          <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.06 + 'em', color: 'var(--color-text-muted)', fontWeight: 700 }}>
                Facturé à
              </h3>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text)' }}>{inlineText('clientName', invoice.client?.name)}</div>
              {invoice.client?.email && (
                <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{invoice.client.email}</div>
              )}
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{inlineText('clientPhone', invoice.client?.phone)}</div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginTop: 4 }}>
                <strong>Adresse:</strong> {inlineText('clientAddress', clientAddress)}
              </div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                <strong>Ville:</strong> {inlineText('clientCity', clientCity)}
              </div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                <strong>MF:</strong> {inlineText('clientTaxId', clientTaxId)}
              </div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                <strong>Contact:</strong> {inlineText('clientContactName', clientContact)}
              </div>
            </div>

            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.06 + 'em', color: 'var(--color-text-muted)', fontWeight: 700 }}>
                Règlement
              </h3>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                <strong>Modalité:</strong> {inlinePaymentTerms(invoice.paymentTerms)}
              </div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                <strong>Banque:</strong> {inlineText('bank', invoice.bank ?? issuer.bank)}
              </div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                <strong>RIB:</strong> {inlineText('rib', invoice.rib ?? issuer.rib)}
              </div>
              <div className="no-print" style={{ color: '#94a3b8', fontSize: 11, marginTop: 8 }}>
                Source: {getFileNameOnly(invoice.sourceFile)}
              </div>
            </div>
          </section>

          {/* Data Quality */}
          {dataChecks.length > 0 ? (
            <section className="no-print" style={{ marginBottom: 16, border: '1px solid #fca5a5', background: '#fff1f2', borderRadius: 'var(--radius-sm)', padding: 12 }}>
              <h4 style={{ margin: '0 0 6px', color: '#9f1239', fontSize: 13 }}>Data quality checks</h4>
              <ul style={{ margin: 0, paddingLeft: 18, color: '#9f1239', fontSize: 12 }}>
                {dataChecks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Line Items Table */}
          <section style={{ marginTop: 8 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Réf.</th>
                  <th>Désignation</th>
                  <th style={{ textAlign: 'right' }}>Qté</th>
                  <th style={{ textAlign: 'right' }}>P.U. (DT)</th>
                  <th style={{ textAlign: 'right' }}>Montant (DT)</th>
                </tr>
              </thead>
              <tbody>
                {(isEditing && editItems ? editItems : invoice.items).map((item, index) => (
                  <tr key={item.id}>
                    <td>{index + 1}</td>
                    <td style={{ fontWeight: 500 }}>
                      {isEditing && editItems
                        ? (item.sku ?? '-')
                        : ((item as InvoiceItem).product?.sku ?? '-')}
                    </td>
                    <td>
                      {isEditing && editItems
                        ? inlineItemValue(index, 'description', (item as EditableInvoiceItem).description || 'Item', { width: 260 })
                        : ((item as InvoiceItem).description ?? (item as InvoiceItem).product?.name ?? 'Item')}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {isEditing && editItems
                        ? inlineItemValue(index, 'quantity', String((item as EditableInvoiceItem).quantity || '0'), { numeric: true, alignRight: true, width: 90 })
                        : (item as InvoiceItem).quantity}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {isEditing && editItems
                        ? inlineItemValue(index, 'unitPrice', String((item as EditableInvoiceItem).unitPrice || '0'), { numeric: true, alignRight: true, width: 120 })
                        : formatTND((item as InvoiceItem).unitPrice)}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {isEditing && editItems
                        ? formatTND((toNumberOrUndefined((item as EditableInvoiceItem).quantity) ?? 0) * (toNumberOrUndefined((item as EditableInvoiceItem).unitPrice) ?? 0))
                        : formatTND((item as InvoiceItem).lineTotal)}
                    </td>
                  </tr>
                ))}
                {(isEditing && editItems ? editItems.length : invoice.items.length) === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 24 }}>
                      No invoice lines found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          {/* Totals Block */}
          <section style={{ marginTop: 20, borderTop: '1px dashed var(--color-border)', paddingTop: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16, alignItems: 'start' }}>
              {/* Left: notes */}
              <div>
                {(invoice.responsable || inlineEnabled) && (
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                    <strong>Responsable:</strong> {inlineText('responsable', invoice.responsable)}
                  </div>
                )}
                {(invoice.amountInWords || inlineEnabled) && (
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                    <strong>Arrêtée la présente facture à la somme de :</strong>{' '}
                    {inlineText('amountInWords', invoice.amountInWords)}
                  </div>
                )}
              </div>

              {/* Right: totals */}
              <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', background: '#f8fafc', borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
                  <span>Total H.T.</span>
                  <strong>{inlineMoney('totalHT', taxableBase)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
                  <span>
                    TVA ({inlinePercent('taxRate', normalizedTaxRate)})
                  </span>
                  <strong>{inlineMoney('taxAmount', Number(invoice.taxAmount || 0))}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
                  <span>Timbre Fiscal</span>
                  <strong>{inlineMoney('timbreFiscal', Number(invoice.timbreFiscal || 0))}</strong>
                </div>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  background: 'var(--color-primary)',
                  color: '#fff',
                }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>Total T.T.C.</span>
                  <span style={{ fontWeight: 800, fontSize: 16 }}>{inlineMoney('totalAmount', Number(invoice.totalAmount || 0))}</span>
                </div>
              </div>
            </div>

            {/* Technical metadata */}
            {extractedMeta ? (
              <details className="no-print" style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 12 }}>Technical payload (advanced)</summary>
                <pre style={{ marginTop: 8, background: '#f8fafc', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 10, fontSize: 11, overflowX: 'auto' }}>
                  {JSON.stringify(extractedMeta, null, 2)}
                </pre>
              </details>
            ) : null}

            {/* Signature area */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 30 }}>Signature et cachet</div>
                <div style={{ borderTop: '1px solid #94a3b8', width: 180, marginLeft: 'auto' }} />
              </div>
            </div>
          </section>
        </article>
      ) : null}
    </main>
  );
}
