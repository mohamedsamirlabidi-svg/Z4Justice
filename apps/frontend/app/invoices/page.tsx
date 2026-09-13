'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiRequest } from '../lib/api';
import { CompanyKey, getCompanyLabel } from '../lib/company';
import { formatTND, formatDate, statusClass } from '../lib/format';

type Invoice = {
  id: string;
  invoiceNo: string;
  date: string;
  dueDate?: string | null;
  status: string;
  currency: string;
  totalAmount: number;
  verified?: boolean;
  sourceFile?: string | null;
  companyName?: string | null;
  companyKey?: 'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS' | 'UNKNOWN';
  documentType?: 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';
  clientId?: string;
  client?: { id?: string; name: string; company?: string | null };
};

type InvoicesResponse = {
  rows: Invoice[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type ClientOption = {
  id: string;
  name: string;
  company?: string | null;
  invoiceCount: number;
};

const statuses = ['draft', 'sent', 'paid', 'overdue', 'pending', 'verified'] as const;
const documentTypes = ['ALL', 'facture', 'devis', 'bon_de_livraison'] as const;
type CompanyFilter = Exclude<CompanyKey, 'UNKNOWN'> | 'ALL';
type DocumentTypeFilter = (typeof documentTypes)[number];

function normalizeDocumentTypeFilter(value: string | null): DocumentTypeFilter {
  if (value === 'facture' || value === 'devis' || value === 'bon_de_livraison') {
    return value;
  }
  if (value === 'bon-de-livraison' || value === 'bon de livraison' || value === 'bl') {
    return 'bon_de_livraison';
  }
  if (value === 'ALL') {
    return 'ALL';
  }
  return 'facture';
}

const companies: Array<{ key: CompanyFilter; label: string }> = [
  { key: 'ALL', label: 'All companies' },
  { key: 'ACROBATE_SOLUTION', label: 'Acrobate Solution' },
  { key: 'GAMESTREAM_ATLAS', label: 'GameStream ATLAS' },
];

export default function InvoicesPage() {
  return (
    <Suspense fallback={<main>Loading invoices…</main>}>
      <InvoicesPageContent />
    </Suspense>
  );
}

function InvoicesPageContent() {
  const searchParams = useSearchParams();
  const urlCompany = (searchParams.get('company') as CompanyFilter | null) ?? 'ALL';
  const urlDocumentType = normalizeDocumentTypeFilter(searchParams.get('documentType'));

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedCompany, setSelectedCompany] = useState<CompanyFilter>(urlCompany);
  const [selectedStatus, setSelectedStatus] = useState('ALL');
  const [selectedDocumentType, setSelectedDocumentType] = useState<DocumentTypeFilter>(urlDocumentType);
  const [selectedClientId, setSelectedClientId] = useState('ALL');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientsBusy, setClientsBusy] = useState(false);
  const [searchNo, setSearchNo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    setSelectedCompany(urlCompany);
    setSelectedDocumentType(urlDocumentType);
    setSelectedClientId('ALL');
    setPage(1);
  }, [urlCompany, urlDocumentType]);

  async function loadClients() {
    setClientsBusy(true);
    try {
      const params = new URLSearchParams();
      if (selectedCompany !== 'ALL') params.set('company', selectedCompany);
      if (selectedDocumentType !== 'ALL') params.set('documentType', selectedDocumentType);

      const data = await apiRequest<Array<{ id: string; name: string; company?: string | null; invoiceCount?: number }>>(
        `/clients/summary?${params.toString()}`
      );

      const normalized = (data ?? [])
        .map((row) => ({
          id: row.id,
          name: row.name,
          company: row.company,
          invoiceCount: Number(row.invoiceCount || 0)
        }))
        .sort((a, b) => b.invoiceCount - a.invoiceCount || a.name.localeCompare(b.name));

      setClients(normalized);
    } catch {
      setClients([]);
    } finally {
      setClientsBusy(false);
    }
  }

  async function loadInvoices() {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('paginated', 'true');
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (selectedCompany !== 'ALL') params.set('company', selectedCompany);
      if (selectedStatus !== 'ALL') params.set('status', selectedStatus);
      if (selectedDocumentType !== 'ALL') params.set('documentType', selectedDocumentType);
      if (selectedClientId !== 'ALL') params.set('clientId', selectedClientId);
      if (searchNo.trim()) params.set('q', searchNo.trim());

      const data = await apiRequest<InvoicesResponse>(`/invoices?${params.toString()}`);
      setInvoices(data.rows);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoices');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadInvoices();
  }, [selectedCompany, selectedStatus, selectedDocumentType, selectedClientId, searchNo, page, pageSize]);

  useEffect(() => {
    void loadClients();
  }, [selectedCompany, selectedDocumentType]);

  useEffect(() => {
    if (selectedClientId === 'ALL') return;
    const exists = clients.some((client) => client.id === selectedClientId);
    if (!exists) {
      setSelectedClientId('ALL');
    }
  }, [clients, selectedClientId]);

  useEffect(() => {
    setPage(1);
  }, [selectedCompany, selectedStatus, selectedDocumentType, selectedClientId, searchNo]);

  async function updateStatus(id: string, status: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await apiRequest(`/invoices/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      setMessage('Invoice updated.');
      await loadInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteInvoice(id: string) {
    if (!confirm('Delete this invoice?')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await apiRequest(`/invoices/${id}`, { method: 'DELETE' });
      setMessage('Invoice deleted.');
      await loadInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  const companyLabel = useMemo(() => {
    if (selectedCompany === 'ALL') return 'All companies';
    return getCompanyLabel(selectedCompany);
  }, [selectedCompany]);

  const documentTitle = useMemo(() => {
    if (selectedDocumentType === 'devis') return 'Devis';
    if (selectedDocumentType === 'bon_de_livraison') return 'Bon de livraison';
    if (selectedDocumentType === 'facture') return 'Factures';
    return 'Documents';
  }, [selectedDocumentType]);

  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (selectedCompany !== 'ALL') count += 1;
    if (selectedStatus !== 'ALL') count += 1;
    if (selectedDocumentType !== 'ALL') count += 1;
    if (selectedClientId !== 'ALL') count += 1;
    if (searchNo.trim()) count += 1;
    return count;
  }, [selectedCompany, selectedStatus, selectedDocumentType, selectedClientId, searchNo]);

  function resetFilters() {
    setSelectedCompany(urlCompany);
    setSelectedStatus('ALL');
    setSelectedDocumentType(urlDocumentType);
    setSelectedClientId('ALL');
    setSearchNo('');
    setPage(1);
  }

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{documentTitle}</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
            Showing <strong>{invoices.length}</strong> / <strong>{total}</strong> {documentTitle.toLowerCase()} · {companyLabel}
          </p>
        </div>
        <button className="button button-primary" onClick={() => void loadInvoices()} disabled={busy}>
          {busy ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* Filters */}
      <section className="card" style={{ padding: '14px 16px', marginBottom: 16, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
            Filters {activeFiltersCount > 0 ? `(${activeFiltersCount} active)` : '(none)'}
          </div>
          <button className="chip" onClick={resetFilters} disabled={busy || clientsBusy} style={{ whiteSpace: 'nowrap' }}>
            Reset filters
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, alignItems: 'stretch' }}>
          <select className="select" value={selectedCompany} onChange={(e) => setSelectedCompany(e.target.value as CompanyFilter)}>
            {companies.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <select className="select" value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value)}>
            <option value="ALL">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select className="select" value={selectedDocumentType} onChange={(e) => setSelectedDocumentType(e.target.value as (typeof documentTypes)[number])}>
            <option value="ALL">All documents</option>
            <option value="facture">Factures only</option>
            <option value="devis">Devis only</option>
            <option value="bon_de_livraison">Bon de livraison only</option>
          </select>

          <select className="select" value={selectedClientId} onChange={(e) => setSelectedClientId(e.target.value)} disabled={clientsBusy}>
            <option value="ALL">{clientsBusy ? 'Loading clients…' : `All clients (${clients.length})`}</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name} {client.invoiceCount > 0 ? `(${client.invoiceCount})` : ''}
              </option>
            ))}
          </select>

          <input
            className="input"
            placeholder="Search invoice no, client, company…"
            value={searchNo}
            onChange={(e) => setSearchNo(e.target.value)}
            style={{ minWidth: 0, width: '100%' }}
          />
        </div>
      </section>

      {message ? <p style={{ color: 'var(--color-success)', fontSize: 13, margin: '8px 0' }}>{message}</p> : null}
      {error ? <p style={{ color: 'var(--color-danger)', fontSize: 13, margin: '8px 0' }}>{error}</p> : null}

      {/* Invoice Table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Invoice No.</th>
              <th>Client</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <Link href={`/invoices/${invoice.id}`} style={{ fontWeight: 600, textDecoration: 'none', color: 'var(--color-primary-light)' }}>
                    {invoice.invoiceNo}
                  </Link>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                    {(invoice.client?.company ?? invoice.companyName ?? '')}
                    {invoice.documentType && invoice.documentType !== 'unknown' ? ` · ${invoice.documentType.toUpperCase()}` : ''}
                    {` · ${invoice.verified ? 'VERIFIED' : 'UNVERIFIED'}`}
                  </div>
                </td>
                <td>
                  {invoice.client ? (
                    <Link href={`/clients/${invoice.client.id ?? invoice.clientId ?? ''}`} style={{ textDecoration: 'none' }}>
                      {invoice.client.name}
                    </Link>
                  ) : (
                    <span style={{ color: 'var(--color-text-muted)' }}>No client</span>
                  )}
                </td>
                <td>{formatDate(invoice.date)}</td>
                <td style={{ fontWeight: 600 }}>{formatTND(invoice.totalAmount)}</td>
                <td>
                  <select
                    className="select"
                    value={invoice.status}
                    onChange={(e) => void updateStatus(invoice.id, e.target.value)}
                    disabled={busy}
                    style={{ fontSize: 12, padding: '3px 6px' }}
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Link href={`/invoices/${invoice.id}`} className="chip" style={{ fontSize: 11 }}>
                      View
                    </Link>
                    <button
                      className="button"
                      onClick={() => void deleteInvoice(invoice.id)}
                      disabled={busy}
                      style={{ fontSize: 11, padding: '3px 8px', color: 'var(--color-danger)' }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!busy && invoices.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 32 }}>
                  No {selectedDocumentType === 'ALL' ? 'documents' : documentTitle.toLowerCase()} found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <section style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <button className="button" disabled={busy || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          ← Previous
        </button>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
          Page {page} / {totalPages}
        </span>
        <button className="button" disabled={busy || page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
          Next →
        </button>
      </section>
    </main>
  );
}
