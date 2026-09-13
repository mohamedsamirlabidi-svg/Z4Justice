'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from './lib/api';
import { getCompanyLabel } from './lib/company';
import { formatTND } from './lib/format';
import { KpiCard } from './components/KpiCard';
import { StatusBadge } from './components/StatusBadge';

type DashboardSummaryResponse = {
  companies: Record<
    'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS',
    { clients: number; invoices: number; revenue: number }
  >;
};

type FileStatsResponse = {
  total: number;
  stats: Record<string, number>;
};

type RecentInvoice = {
  id: string;
  invoiceNo: string;
  date: string;
  totalAmount: number;
  status: string;
  documentType?: 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';
  client?: { name: string };
};

type RecentInvoicesResponse = {
  rows: RecentInvoice[];
};

type DocumentMetric = {
  invoices: number;
  totalAmount: number;
  outstanding: number;
};

type DocumentMetricsResponse = Record<string, DocumentMetric>;

type DocumentMetrics = {
  facture: DocumentMetric;
  devis: DocumentMetric;
  bon_de_livraison: DocumentMetric;
};

function getDocumentLabel(type: RecentInvoice['documentType']): string {
  if (type === 'devis') return 'DEVIS';
  if (type === 'bon_de_livraison') return 'BON DE LIVRAISON';
  return 'FACTURE';
}

type ImportedFile = {
  id: string;
  filename: string;
  status: string;
  detectedAt: string;
  processedAt?: string | null;
};

const companyKeys: Array<'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS'> = [
  'ACROBATE_SOLUTION',
  'GAMESTREAM_ATLAS',
];

const companyColors: Record<string, string> = {
  ACROBATE_SOLUTION: 'var(--color-primary-light)',
  GAMESTREAM_ATLAS: 'var(--color-secondary)',
};

export default function HomePage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);
  const [fileStats, setFileStats] = useState<FileStatsResponse | null>(null);
  const [recentInvoices, setRecentInvoices] = useState<RecentInvoice[]>([]);
  const [documentMetrics, setDocumentMetrics] = useState<DocumentMetrics>({
    facture: { invoices: 0, totalAmount: 0, outstanding: 0 },
    devis: { invoices: 0, totalAmount: 0, outstanding: 0 },
    bon_de_livraison: { invoices: 0, totalAmount: 0, outstanding: 0 },
  });
  const [lastProcessedFile, setLastProcessedFile] = useState<ImportedFile | null>(null);

  const loadPipelineStatus = useCallback(async () => {
    const [statsResult, filesResult] = await Promise.allSettled([
      apiRequest<FileStatsResponse>('/files/stats'),
      apiRequest<ImportedFile[]>('/files?limit=50'),
    ]);

    if (statsResult.status === 'fulfilled') {
      setFileStats(statsResult.value);
    }

    if (filesResult.status === 'fulfilled') {
      const processed = (filesResult.value ?? []).find((f) => f.status === 'processed' && f.processedAt);
      setLastProcessedFile(processed ?? null);
    }

    if (statsResult.status === 'rejected' && filesResult.status === 'rejected') {
      throw new Error('Failed to refresh pipeline status from backend');
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [summaryResult, invoicesResult, metricsResult] = await Promise.allSettled([
        apiRequest<DashboardSummaryResponse>('/invoices/summary'),
        apiRequest<RecentInvoicesResponse>('/invoices?paginated=true&page=1&pageSize=8'),
        apiRequest<DocumentMetricsResponse>('/clients/document-metrics'),
      ]);

      if (summaryResult.status === 'fulfilled') {
        setSummary(summaryResult.value);
      }

      if (invoicesResult.status === 'fulfilled') {
        setRecentInvoices(invoicesResult.value.rows ?? []);
      }

      if (metricsResult.status === 'fulfilled') {
        const m = metricsResult.value;
        setDocumentMetrics({
          facture: m.facture ?? { invoices: 0, totalAmount: 0, outstanding: 0 },
          devis: m.devis ?? { invoices: 0, totalAmount: 0, outstanding: 0 },
          bon_de_livraison: m.bon_de_livraison ?? { invoices: 0, totalAmount: 0, outstanding: 0 },
        });
      }

      if (
        summaryResult.status === 'rejected' &&
        invoicesResult.status === 'rejected' &&
        metricsResult.status === 'rejected'
      ) {
        throw new Error('Failed to load dashboard data');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    void loadPipelineStatus().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to refresh pipeline status');
    });
  }, [loadPipelineStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      void loadPipelineStatus().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to refresh pipeline status');
      });
    }, 30000);

    return () => clearInterval(interval);
  }, [loadPipelineStatus]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void loadPipelineStatus().catch(() => undefined);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadPipelineStatus]);

  const totals = useMemo(() => {
    if (!summary) return { invoices: 0, revenue: 0, clients: 0, pending: 0 };
    const acro = summary.companies.ACROBATE_SOLUTION ?? { invoices: 0, revenue: 0, clients: 0 };
    const game = summary.companies.GAMESTREAM_ATLAS ?? { invoices: 0, revenue: 0, clients: 0 };
    return {
      invoices: documentMetrics.facture.invoices + documentMetrics.devis.invoices + documentMetrics.bon_de_livraison.invoices,
      revenue: documentMetrics.facture.totalAmount,
      clients: acro.clients + game.clients,
      pending: fileStats?.stats?.queued ?? 0,
    };
  }, [summary, fileStats, documentMetrics]);

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>Dashboard</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>
            Real-time metrics for Acrobate Solution and GameStream ATLAS
          </p>
        </div>
        <button className="button button-primary" onClick={() => void loadDashboard()} disabled={busy}>
          {busy ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: '#fecaca', color: '#b91c1c', padding: 16, marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {/* KPI Cards */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <KpiCard title="Total Invoices" value={totals.invoices} icon="🧾" color="var(--color-primary-light)" />
        <KpiCard title="Facture Revenue" value={formatTND(totals.revenue)} icon="💰" color="var(--color-success)" />
        <KpiCard title="Clients" value={totals.clients} icon="👥" color="var(--color-secondary)" />
        <KpiCard title="Pending Ingestion" value={totals.pending} icon="📥" color="var(--color-accent)" />
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <article className="card" style={{ padding: '16px 18px', borderTop: '3px solid var(--color-success)' }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 700, letterSpacing: '0.04em' }}>FACTURES</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 800 }}>{documentMetrics.facture.invoices}</div>
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-muted)' }}>Total: {formatTND(documentMetrics.facture.totalAmount)}</div>
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-muted)' }}>Outstanding: {formatTND(documentMetrics.facture.outstanding)}</div>
          <div style={{ marginTop: 10 }}>
            <Link href="/invoices?documentType=facture" className="chip">Open factures</Link>
          </div>
        </article>

        <article className="card" style={{ padding: '16px 18px', borderTop: '3px solid var(--color-secondary)' }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 700, letterSpacing: '0.04em' }}>DEVIS</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 800 }}>{documentMetrics.devis.invoices}</div>
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-muted)' }}>Total: {formatTND(documentMetrics.devis.totalAmount)}</div>
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-muted)' }}>Outstanding: {formatTND(documentMetrics.devis.outstanding)}</div>
          <div style={{ marginTop: 10 }}>
            <Link href="/invoices?documentType=devis" className="chip">Open devis</Link>
          </div>
        </article>

        <article className="card" style={{ padding: '16px 18px', borderTop: '3px solid var(--color-accent)' }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 700, letterSpacing: '0.04em' }}>BON DE LIVRAISON</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 800 }}>{documentMetrics.bon_de_livraison.invoices}</div>
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-muted)' }}>Total: {formatTND(documentMetrics.bon_de_livraison.totalAmount)}</div>
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-muted)' }}>Outstanding: {formatTND(documentMetrics.bon_de_livraison.outstanding)}</div>
          <div style={{ marginTop: 10 }}>
            <Link href="/invoices?documentType=bon_de_livraison" className="chip">Open BL</Link>
          </div>
        </article>
      </section>

      {/* Revenue by Company */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
        {companyKeys.map((key) => {
          const data = summary?.companies[key] ?? { clients: 0, invoices: 0, revenue: 0 };
          return (
            <article
              key={key}
              className="card"
              style={{
                padding: '20px 24px',
                borderLeft: `4px solid ${companyColors[key]}`,
              }}
            >
              <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>
                {getCompanyLabel(key)}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Clients
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{data.clients}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Invoices
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{data.invoices}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Revenue
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{formatTND(data.revenue)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <Link href={`/clients?company=${key}`} className="chip">
                  View clients
                </Link>
                <Link href={`/invoices?company=${key}`} className="chip">
                  View invoices
                </Link>
              </div>
            </article>
          );
        })}
      </section>

      {/* Recent Documents */}
      <section className="card" style={{ padding: '20px 24px', marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Recent documents</h3>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Client</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentInvoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <Link href={`/invoices/${invoice.id}`} style={{ textDecoration: 'none', color: 'var(--color-primary-light)', fontWeight: 600 }}>
                      {invoice.invoiceNo}
                    </Link>
                  </td>
                  <td>
                    <span className="chip" style={{ fontSize: 11 }}>{getDocumentLabel(invoice.documentType)}</span>
                  </td>
                  <td>{invoice.client?.name ?? '-'}</td>
                  <td>{new Date(invoice.date).toLocaleDateString('fr-TN')}</td>
                  <td>{formatTND(invoice.totalAmount)}</td>
                  <td><StatusBadge status={invoice.status} /></td>
                </tr>
              ))}
              {recentInvoices.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 24 }}>
                    No documents found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* File Ingestion Status */}
      <section className="card" style={{ padding: '20px 24px' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Pipeline Status</h3>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-text-muted)', display: 'inline-block' }} />
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              Total files: <strong style={{ color: 'var(--color-text)' }}>{fileStats?.total ?? 0}</strong>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }} />
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              Processed: <strong style={{ color: 'var(--color-success)' }}>{fileStats?.stats?.processed ?? 0}</strong>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-accent)', display: 'inline-block' }} />
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              Queued: <strong style={{ color: 'var(--color-accent)' }}>{fileStats?.stats?.queued ?? 0}</strong>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-danger)', display: 'inline-block' }} />
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              Failed: <strong style={{ color: 'var(--color-danger)' }}>{fileStats?.stats?.failed ?? 0}</strong>
            </span>
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--color-text-muted)' }}>
          <strong>Queue length:</strong> {fileStats?.stats?.queued ?? 0}
          <span style={{ margin: '0 8px' }}>·</span>
          <strong>Last processed:</strong>{' '}
          {lastProcessedFile
            ? `${lastProcessedFile.filename} (${new Date(lastProcessedFile.processedAt || lastProcessedFile.detectedAt).toLocaleString('fr-TN')})`
            : '—'}
        </div>
        <div style={{ marginTop: 12 }}>
          <Link href="/files" className="chip">
            Go to ingestion monitor →
          </Link>
        </div>
      </section>
    </main>
  );
}
