'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiRequest } from '../lib/api';
import { CompanyKey, getCompanyLabel } from '../lib/company';

type ClientSummary = {
  id: string;
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  detectedCompany: CompanyKey;
  invoiceCount: number;
  totalBilled: number;
  outstanding: number;
};

type ClientSummaryResponse = {
  rows: ClientSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type CompanyFilter = Exclude<CompanyKey, 'UNKNOWN'> | 'ALL';
type DocumentTypeFilter = 'ALL' | 'facture' | 'devis' | 'bon_de_livraison';

const companyFilters: Array<{ key: CompanyFilter; label: string }> = [
  { key: 'ALL', label: 'All companies' },
  { key: 'ACROBATE_SOLUTION', label: 'Acrobate Solution' },
  { key: 'GAMESTREAM_ATLAS', label: 'GameStream ATLAS' }
];

export default function ClientsPage() {
  return (
    <Suspense fallback={<main>Loading clients...</main>}>
      <ClientsPageContent />
    </Suspense>
  );
}

function ClientsPageContent() {
  const searchParams = useSearchParams();
  const initialCompany = (searchParams.get('company') as CompanyFilter | null) ?? 'ALL';

  const [rows, setRows] = useState<ClientSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedCompany, setSelectedCompany] = useState<CompanyFilter>(initialCompany);
  const [selectedDocumentType, setSelectedDocumentType] = useState<DocumentTypeFilter>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  async function loadData() {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('paginated', 'true');
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (selectedCompany !== 'ALL') params.set('company', selectedCompany);
      if (selectedDocumentType !== 'ALL') params.set('documentType', selectedDocumentType);
      if (query.trim()) params.set('q', query.trim());

      const response = await apiRequest<ClientSummaryResponse>(`/clients/summary?${params.toString()}`);
      setRows(response.rows);
      setTotal(response.total);
      setTotalPages(response.totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clients');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [page, pageSize, selectedCompany, selectedDocumentType, query]);

  useEffect(() => {
    setPage(1);
  }, [selectedCompany, selectedDocumentType, query]);

  const companyLabel = useMemo(() => {
    if (selectedCompany === 'ALL') return 'All companies';
    return getCompanyLabel(selectedCompany);
  }, [selectedCompany]);

  return (
    <main>
      <h1 style={{ marginTop: 0 }}>Clients</h1>
      <p style={{ color: '#64748b', marginTop: 0 }}>
        Server-side filtered clients with balances for fast loading on large datasets.
      </p>
      <p style={{ marginTop: 0, color: '#64748b', fontSize: 13 }}>
        Showing <strong>{rows.length}</strong> / <strong>{total}</strong> clients • {companyLabel}
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {companyFilters.map((company) => (
          <button
            key={company.key}
            className={`chip ${selectedCompany === company.key ? 'chip-active' : ''}`}
            onClick={() => setSelectedCompany(company.key)}
          >
            {company.label}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="Search name / email / phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ minWidth: 280 }}
          />
          <select className="select" value={selectedDocumentType} onChange={(e) => setSelectedDocumentType(e.target.value as DocumentTypeFilter)}>
            <option value="ALL">All documents</option>
            <option value="facture">Factures only</option>
            <option value="devis">Devis only</option>
            <option value="bon_de_livraison">Bon de livraison only</option>
          </select>
        </div>
      </div>

      {busy ? <p>Loading...</p> : null}
      {error ? <p style={{ color: '#b91c1c' }}>{error}</p> : null}

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 12
        }}
      >
        {rows.map((entry) => (
          <article key={entry.id} className="card" style={{ padding: '1rem' }}>
            <h3 style={{ margin: '0 0 6px' }}>{entry.name}</h3>
            <p style={{ margin: '4px 0', color: '#64748b' }}>
              {entry.detectedCompany === 'UNKNOWN' ? 'Unknown company' : getCompanyLabel(entry.detectedCompany)}
            </p>
            <p style={{ margin: '4px 0', color: '#64748b' }}>{entry.email ?? 'No email'}</p>
            <p style={{ margin: '4px 0 8px', color: '#64748b' }}>{entry.phone ?? 'No phone'}</p>

            <div style={{ fontSize: 14, color: '#334155' }}>
              <div>Invoices: {entry.invoiceCount}</div>
              <div>Total billed: TND {Number(entry.totalBilled || 0).toFixed(2)}</div>
              <div>Outstanding balance: TND {Number(entry.outstanding || 0).toFixed(2)}</div>
            </div>

            <div style={{ marginTop: 10 }}>
              {(() => {
                const queryString = new URLSearchParams({
                  ...(selectedCompany !== 'ALL' ? { company: selectedCompany } : {}),
                  ...(selectedDocumentType !== 'ALL' ? { documentType: selectedDocumentType } : {})
                }).toString();

                const href = queryString ? `/clients/${entry.id}?${queryString}` : `/clients/${entry.id}`;

                return (
              <Link
                href={href}
                className="chip"
              >
                View client dashboard
              </Link>
                );
              })()}
            </div>
          </article>
        ))}
      </section>

      {!busy && rows.length === 0 ? <p style={{ color: '#64748b', marginTop: 10 }}>No clients found.</p> : null}

      <section style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="button" disabled={busy || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Previous
        </button>
        <span style={{ color: '#64748b', fontSize: 14 }}>
          Page {page} / {totalPages}
        </span>
        <button className="button" disabled={busy || page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
          Next
        </button>
      </section>
    </main>
  );
}
