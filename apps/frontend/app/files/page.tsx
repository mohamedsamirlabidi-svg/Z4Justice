'use client';

import Link from 'next/link';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { apiRequest } from '../lib/api';
import { formatDate } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';

type ImportedFile = {
  id: string;
  filename: string;
  fullPath: string;
  extension: string;
  status: string;
  detectedAt: string;
  processedAt?: string | null;
  notes?: string | null;
  invoiceLinked?: {
    id: string;
    invoiceNo: string;
    status: string;
    verified?: boolean;
    documentType?: string;
  } | null;
};

type FileStatsResponse = {
  total: number;
  stats: Record<string, number>;
};

type FailedFilesResponse = {
  total: number;
  rows: ImportedFile[];
};

type RescanResultRow = {
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

type RescanResponse = {
  requested?: number;
  totalEligible?: number;
  skipVerified?: boolean;
  skippedVerifiedCount?: number;
  scanned: number;
  hasMore?: boolean;
  remaining?: number;
  pending?: Array<{
    id: string;
    filename: string;
    fullPath: string;
    processedAt?: string | null;
  }>;
  timedOut?: boolean;
  verifiedCount?: number;
  unverifiedCount?: number;
  filesWithIssues: number;
  filesWithWarnings: number;
  durationMs?: number;
  results: RescanResultRow[];
};

export default function FilesPage() {
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [failedFiles, setFailedFiles] = useState<ImportedFile[]>([]);
  const [stats, setStats] = useState<FileStatsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [lastRescan, setLastRescan] = useState<RescanResponse | null>(null);
  const [rescannedFilesCount, setRescannedFilesCount] = useState(0);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterDocType, setFilterDocType] = useState<string>('ALL');
  const [filterVerified, setFilterVerified] = useState<string>('ALL');

  /** Detect document type from the file path */
  function detectDocType(fullPath: string): string {
    const p = fullPath.toUpperCase().replace(/\\/g, '/');
    if (/BON DE LIVRAISON|BON DE LIV|\/BL\/|\/BL /.test(p)) return 'bon_de_livraison';
    if (/\/DEVIS\/|\/DEVIS |DEVIS\//.test(p)) return 'devis';
    if (/\/FACTURE|FACTURES\/|FACTURES |FACTURE\//.test(p)) return 'facture';
    return 'unknown';
  }

  function docTypeLabel(dt: string): string {
    if (dt === 'devis') return 'Devis';
    if (dt === 'bon_de_livraison') return 'BL';
    if (dt === 'facture') return 'Facture';
    return '—';
  }

  function docTypeBadgeColor(dt: string): { bg: string; color: string } {
    if (dt === 'facture') return { bg: 'rgba(22, 163, 74, 0.12)', color: 'var(--color-success)' };
    if (dt === 'devis') return { bg: 'rgba(37, 99, 235, 0.10)', color: 'var(--color-primary-light)' };
    if (dt === 'bon_de_livraison') return { bg: 'rgba(245, 158, 11, 0.12)', color: 'var(--color-accent)' };
    return { bg: 'rgba(100, 116, 139, 0.10)', color: 'var(--color-text-muted)' };
  }

  /** Filtered files with memoization */
  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      if (filterStatus !== 'ALL' && f.status !== filterStatus) return false;
      const dt = f.invoiceLinked?.documentType ?? detectDocType(f.fullPath);
      if (filterDocType !== 'ALL' && dt !== filterDocType) return false;
      if (filterVerified === 'verified' && !f.invoiceLinked?.verified) return false;
      if (filterVerified === 'unverified' && f.invoiceLinked?.verified) return false;
      if (filterVerified === 'no_invoice' && f.invoiceLinked) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchFile = f.filename.toLowerCase().includes(q) || f.fullPath.toLowerCase().includes(q);
        const matchInvoice = f.invoiceLinked?.invoiceNo?.toLowerCase().includes(q);
        if (!matchFile && !matchInvoice) return false;
      }
      return true;
    });
  }, [files, filterStatus, filterDocType, filterVerified, searchQuery]);

  /** Aggregate counts for summary cards */
  const fileCounts = useMemo(() => {
    let verified = 0;
    let unverified = 0;
    let noInvoice = 0;
    let facture = 0;
    let devis = 0;
    let bl = 0;
    for (const f of files) {
      if (f.invoiceLinked?.verified) verified++;
      else if (f.invoiceLinked) unverified++;
      else noInvoice++;
      const dt = f.invoiceLinked?.documentType ?? detectDocType(f.fullPath);
      if (dt === 'facture') facture++;
      else if (dt === 'devis') devis++;
      else if (dt === 'bon_de_livraison') bl++;
    }
    return { verified, unverified, noInvoice, facture, devis, bl };
  }, [files]);

  const loadFiles = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [filesResult, statsResult, failedResult] = await Promise.allSettled([
        apiRequest<ImportedFile[]>('/files?limit=300'),
        apiRequest<FileStatsResponse>('/files/stats'),
        apiRequest<FailedFilesResponse>('/files/failed?limit=25'),
      ]);

      if (filesResult.status === 'fulfilled') {
        setFiles(filesResult.value);
      }

      if (statsResult.status === 'fulfilled') {
        setStats(statsResult.value);
      }

      if (failedResult.status === 'fulfilled') {
        setFailedFiles(
          [...failedResult.value.rows].sort((a, b) => {
            const aTime = new Date(a.processedAt ?? a.detectedAt).getTime();
            const bTime = new Date(b.processedAt ?? b.detectedAt).getTime();
            return bTime - aTime;
          })
        );
      }

      if (
        filesResult.status === 'rejected' &&
        statsResult.status === 'rejected' &&
        failedResult.status === 'rejected'
      ) {
        throw new Error('Failed to load ingestion monitor data');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setBusy(false);
    }
  }, []);

  // Initial load + auto-refresh every 5 seconds
  useEffect(() => {
    void loadFiles();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      void loadFiles();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadFiles]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void loadFiles();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadFiles]);

  async function processFile(id: string) {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await apiRequest(`/files/${id}/process`, { method: 'POST' });
      setMessage('File processed.');
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Process failed');
    } finally {
      setBusy(false);
    }
  }

  async function processQueued() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await apiRequest<{
        total: number;
        succeeded: number;
        failed: number;
        batches?: number;
        remainingQueued?: number;
        drained?: boolean;
      }>('/files/process-queued', { method: 'POST' });

      const remaining = Number(result.remainingQueued || 0);
      const statusText =
        remaining === 0 || result.drained
          ? 'Queue drained'
          : `Queue not empty (${remaining} remaining)`;

      setMessage(
        `${statusText} · ${result.succeeded}/${result.total} succeeded · ${result.failed} failed` +
        `${result.batches ? ` · batches: ${result.batches}` : ''}`
      );
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Queue process failed');
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await apiRequest<{ total: number; succeeded: number; failed: number }>(
        '/files/retry-failed?limit=500',
        { method: 'POST', body: JSON.stringify({}) }
      );
      setMessage(`Retry done: ${result.succeeded}/${result.total} succeeded, ${result.failed} still failed.`);
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  }

  async function rescanProcessed() {
    setRescanBusy(true);
    setMessage('');
    setError('');
    try {
      const maxPasses = 30;
      let pass = 0;
      let totalScanned = 0;
      let totalIssues = 0;
      let totalWarnings = 0;
      let totalVerified = 0;
      let totalUnverified = 0;
      let totalSkippedVerified = 0;
      const scannedIds = new Set<string>();
      const collectedResults: RescanResultRow[] = [];
      let lastBatch: RescanResponse | null = null;

      while (pass < maxPasses) {
        pass += 1;
        const batch = await apiRequest<RescanResponse>(
          '/files/rescan-processed?limit=500&concurrency=6&useAi=true&updateInvoice=true&skipVerified=true',
          {
            method: 'POST',
            body: JSON.stringify({ excludeIds: Array.from(scannedIds) })
          }
        );
        lastBatch = batch;

        totalScanned += batch.scanned;
        totalIssues += batch.filesWithIssues;
        totalWarnings += batch.filesWithWarnings;
        totalVerified += batch.verifiedCount ?? 0;
        totalUnverified += batch.unverifiedCount ?? 0;
        totalSkippedVerified += batch.skippedVerifiedCount ?? 0;

        for (const row of batch.results) {
          scannedIds.add(row.importedFileId);
        }

        if (collectedResults.length < 300) {
          collectedResults.push(...batch.results.slice(0, 300 - collectedResults.length));
        }

        const noMore = batch.hasMore === false || (batch.scanned === 0 && (batch.remaining ?? 0) === 0);
        if (noMore) {
          break;
        }
      }

      const result: RescanResponse = {
        ...(lastBatch ?? {
          scanned: 0,
          filesWithIssues: 0,
          filesWithWarnings: 0,
          results: []
        }),
        scanned: totalScanned,
        filesWithIssues: totalIssues,
        filesWithWarnings: totalWarnings,
        verifiedCount: totalVerified,
        unverifiedCount: totalUnverified,
        skippedVerifiedCount: totalSkippedVerified,
        hasMore: false,
        remaining: 0,
        results: collectedResults
      };

      setLastRescan(result);
      setRescannedFilesCount(totalScanned);

      const wasPartial = Boolean(result.timedOut) || Number(result.remaining ?? 0) > 0;
      const baseText = wasPartial
        ? `Rescan partial · scanned: ${result.scanned}/${result.requested ?? result.scanned}`
        : `Rescan completed · scanned: ${result.scanned}`;

      setMessage(
        `${baseText} · issues: ${result.filesWithIssues} · warnings: ${result.filesWithWarnings}` +
          `${typeof result.skippedVerifiedCount === 'number' ? ` · skipped verified: ${result.skippedVerifiedCount}` : ''}` +
          `${wasPartial ? ` · remaining: ${result.remaining ?? 0}` : ''}` +
          `${typeof result.verifiedCount === 'number' ? ` · verified: ${result.verifiedCount}` : ''}` +
          ` · AI: on` +
          `${result.durationMs ? ` · ${Math.round(result.durationMs / 1000)}s` : ''}`
      );
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rescan failed');
    } finally {
      setRescanBusy(false);
    }
  }

  async function migrateAll(processNow = true) {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await apiRequest<{
        scanned: number;
        queued: number;
        skipped: number;
        processed: number;
        failed: number;
        processNow: boolean;
      }>(`/files/migrate-all?processNow=${processNow ? 'true' : 'false'}`, { method: 'POST' });

      setMessage(
        [
          `Migration complete.`,
          `Scanned: ${result.scanned}`,
          `Queued: ${result.queued}`,
          `Skipped: ${result.skipped}`,
          result.processNow ? `Processed: ${result.processed}` : undefined,
          result.processNow ? `Failed: ${result.failed}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      );
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Migration failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile(id: string) {
    if (!confirm('Delete this imported file record?')) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await apiRequest(`/files/${id}`, { method: 'DELETE' });
      setMessage('File record deleted.');
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Ingestion Monitor</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
            Source files, migration, and processing status · Auto-refreshing every 5s
          </p>
        </div>
        <button className="button button-primary" onClick={() => void loadFiles()} disabled={busy}>
          {busy ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* Pipeline Stats */}
      <section className="card" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700 }}>Pipeline Overview</h3>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{stats?.total ?? 0}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total files</div>
          </div>
          <div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-success)' }}>{stats?.stats?.processed ?? 0}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Processed</div>
          </div>
          <div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-accent)' }}>{stats?.stats?.queued ?? 0}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Queued</div>
          </div>
          <div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-danger)' }}>{stats?.stats?.failed ?? 0}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Failed</div>
          </div>
          <div style={{ borderLeft: '1px solid var(--color-border)', paddingLeft: 24 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-primary-light)' }}>{rescannedFilesCount}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Rescanned (last run)
            </div>
          </div>
        </div>
      </section>

      {/* Verification & Document Type Summary */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        <div className="card" style={{ padding: '12px 16px', borderTop: '3px solid var(--color-success)' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-success)' }}>{fileCounts.verified}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>Verified</div>
        </div>
        <div className="card" style={{ padding: '12px 16px', borderTop: '3px solid var(--color-accent)' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-accent)' }}>{fileCounts.unverified}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>Unverified</div>
        </div>
        <div className="card" style={{ padding: '12px 16px', borderTop: '3px solid var(--color-text-muted)' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-muted)' }}>{fileCounts.noInvoice}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>No Invoice</div>
        </div>
        <div className="card" style={{ padding: '12px 16px', borderTop: '3px solid var(--color-success)' }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{fileCounts.facture}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>Factures</div>
        </div>
        <div className="card" style={{ padding: '12px 16px', borderTop: '3px solid var(--color-primary-light)' }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{fileCounts.devis}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>Devis</div>
        </div>
        <div className="card" style={{ padding: '12px 16px', borderTop: '3px solid var(--color-accent)' }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{fileCounts.bl}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>Bon de Livraison</div>
        </div>
      </section>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="button button-primary" onClick={() => void migrateAll(true)} disabled={busy || rescanBusy}>
          Migrate all now
        </button>
        <button className="button" onClick={() => void processQueued()} disabled={busy || rescanBusy}>
          Process queued
        </button>
        <button className="button" onClick={() => void rescanProcessed()} disabled={busy || rescanBusy || (stats?.stats?.processed ?? 0) === 0}>
          {rescanBusy ? 'Rescanning…' : `Rescan processed (${stats?.stats?.processed ?? 0})`}
        </button>
        <button
          className="button button-danger"
          onClick={() => void retryFailed()}
          disabled={busy || rescanBusy || (stats?.stats?.failed ?? 0) === 0}
        >
          Retry Failed ({stats?.stats?.failed ?? 0})
        </button>
      </div>

      {lastRescan ? (
        <section className="card" style={{ padding: '14px 18px', marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700 }}>Last Rescan Report</h3>

          {/* Rescan summary stats row */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ background: 'rgba(37, 99, 235, 0.08)', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
              <strong>{lastRescan.scanned}</strong> scanned
              {lastRescan.requested ? <span style={{ color: 'var(--color-text-muted)' }}> / {lastRescan.requested}</span> : null}
            </div>
            <div style={{ background: 'rgba(22, 163, 74, 0.08)', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
              <strong style={{ color: 'var(--color-success)' }}>{lastRescan.verifiedCount ?? 0}</strong> verified
            </div>
            <div style={{ background: 'rgba(245, 158, 11, 0.08)', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
              <strong style={{ color: 'var(--color-accent)' }}>{lastRescan.unverifiedCount ?? 0}</strong> unverified
            </div>
            {lastRescan.filesWithIssues > 0 ? (
              <div style={{ background: 'rgba(220, 38, 38, 0.08)', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
                <strong style={{ color: 'var(--color-danger)' }}>{lastRescan.filesWithIssues}</strong> with issues
              </div>
            ) : null}
            {lastRescan.filesWithWarnings > 0 ? (
              <div style={{ background: 'rgba(217, 119, 6, 0.08)', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
                <strong style={{ color: 'var(--color-warning)' }}>{lastRescan.filesWithWarnings}</strong> with warnings
              </div>
            ) : null}
            {typeof lastRescan.skippedVerifiedCount === 'number' && lastRescan.skippedVerifiedCount > 0 ? (
              <div style={{ background: 'rgba(100, 116, 139, 0.08)', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
                <strong>{lastRescan.skippedVerifiedCount}</strong> skipped (verified)
              </div>
            ) : null}
          </div>

          {(lastRescan.pending?.length ?? 0) > 0 ? (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Not rescanned yet (next pending files)</div>
              <div style={{ display: 'grid', gap: 4 }}>
                {(lastRescan.pending ?? []).slice(0, 12).map((pendingFile) => (
                  <div key={`pending-${pendingFile.id}`} style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    • {pendingFile.filename}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Rescan result rows */}
          <div style={{ display: 'grid', gap: 6 }}>
            {lastRescan.results
              .slice(0, 40)
              .map((row) => (
                <article key={`audit-${row.importedFileId}`} style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{row.filename}</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {row.invoiceNo ? (
                        <span style={{ fontSize: 11, color: 'var(--color-primary-light)', fontWeight: 600 }}>{row.invoiceNo}</span>
                      ) : null}
                      <span
                        style={{
                          borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 700,
                          background: row.verified ? 'rgba(16, 185, 129, 0.16)' : 'rgba(148, 163, 184, 0.2)',
                          color: row.verified ? 'var(--color-success)' : 'var(--color-text-muted)',
                        }}
                      >
                        {row.verified ? 'Verified' : 'Unverified'}
                      </span>
                      {row.aiUpdated ? (
                        <span style={{ borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 700, background: 'rgba(139, 92, 246, 0.12)', color: '#7c3aed' }}>AI</span>
                      ) : null}
                    </div>
                  </div>
                  {row.issues.length > 0 ? (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-danger)' }}>
                      Issues: {row.issues.join(' | ')}
                    </div>
                  ) : null}
                  {row.warnings.length > 0 ? (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-accent)' }}>
                      Warnings: {row.warnings.join(' | ')}
                    </div>
                  ) : null}
                </article>
              ))}
            {lastRescan.results.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-success)' }}>No rows returned for last rescan.</div>
            ) : null}
          </div>
        </section>
      ) : null}

      {message ? <p style={{ color: 'var(--color-success)', fontSize: 13, margin: '8px 0' }}>{message}</p> : null}
      {error ? <p style={{ color: 'var(--color-danger)', fontSize: 13, margin: '8px 0' }}>{error}</p> : null}

      {/* Failed Files Section */}
      {failedFiles.length > 0 && (
        <section style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: 'var(--color-danger)' }}>
            ⚠ Failed Files ({failedFiles.length})
          </h2>
          <div style={{ display: 'grid', gap: 8 }}>
            {failedFiles.map((file) => (
              <article key={`failed-${file.id}`} className="card" style={{ padding: 12, borderLeftColor: 'var(--color-danger)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div>
                    <strong>{file.filename}</strong>
                    <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 2 }}>{file.fullPath}</div>
                  </div>
                  <button className="button" onClick={() => void processFile(file.id)} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>
                    Retry
                  </button>
                </div>
                <div style={{ marginTop: 6, color: 'var(--color-danger)', fontSize: 12 }}>
                  {file.notes?.trim() ? file.notes : 'No error details captured'}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* File Table Filters */}
      <section className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
            Showing <strong>{filteredFiles.length}</strong> / {files.length} files
          </div>
          <button
            className="chip"
            onClick={() => { setSearchQuery(''); setFilterStatus('ALL'); setFilterDocType('ALL'); setFilterVerified('ALL'); }}
            style={{ whiteSpace: 'nowrap' }}
          >
            Reset filters
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
          <input
            className="input"
            placeholder="Search filename, path, invoice…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ minWidth: 0, width: '100%' }}
          />
          <select className="select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="ALL">All statuses</option>
            <option value="processed">Processed</option>
            <option value="queued">Queued</option>
            <option value="failed">Failed</option>
            <option value="processing">Processing</option>
          </select>
          <select className="select" value={filterDocType} onChange={(e) => setFilterDocType(e.target.value)}>
            <option value="ALL">All doc types</option>
            <option value="facture">Facture</option>
            <option value="devis">Devis</option>
            <option value="bon_de_livraison">Bon de Livraison</option>
            <option value="unknown">Unknown</option>
          </select>
          <select className="select" value={filterVerified} onChange={(e) => setFilterVerified(e.target.value)}>
            <option value="ALL">All verification</option>
            <option value="verified">Verified only</option>
            <option value="unverified">Unverified only</option>
            <option value="no_invoice">No invoice linked</option>
          </select>
        </div>
      </section>

      {/* All Files Table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Ext</th>
              <th>Doc Type</th>
              <th>Status</th>
              <th>Detected At</th>
              <th>Processed At</th>
              <th>Invoice Linked</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredFiles.map((file) => {
              const dt = file.invoiceLinked?.documentType ?? detectDocType(file.fullPath);
              const dtBadge = docTypeBadgeColor(dt);
              return (
                <tr
                  key={file.id}
                  style={{
                    background:
                      file.status === 'failed'
                        ? '#fff1f2'
                        : file.status === 'processed'
                          ? '#f0fdf4'
                          : file.status === 'processing'
                            ? '#eff6ff'
                            : file.status === 'queued'
                              ? '#f8fafc'
                              : undefined,
                  }}
                >
                  <td>
                    <div style={{ fontWeight: 500 }}>{file.filename}</div>
                    <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{file.fullPath}</div>
                  </td>
                  <td><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{file.extension}</span></td>
                  <td>
                    <span
                      style={{
                        borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 700,
                        background: dtBadge.bg, color: dtBadge.color,
                      }}
                    >
                      {docTypeLabel(dt)}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={file.status} />
                  </td>
                  <td style={{ fontSize: 12 }}>{formatDate(file.detectedAt)}</td>
                  <td style={{ fontSize: 12 }}>{file.processedAt ? formatDate(file.processedAt) : '-'}</td>
                  <td style={{ fontSize: 12 }}>
                    {file.invoiceLinked ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Link href={`/invoices/${file.invoiceLinked.id}`} style={{ color: 'var(--color-primary-light)', textDecoration: 'none', fontWeight: 600 }}>
                          {file.invoiceLinked.invoiceNo}
                        </Link>
                        <span
                          style={{
                            borderRadius: 999,
                            padding: '2px 8px',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.02em',
                            background: file.invoiceLinked.verified ? 'rgba(16, 185, 129, 0.16)' : 'rgba(148, 163, 184, 0.2)',
                            color: file.invoiceLinked.verified ? 'var(--color-success)' : 'var(--color-text-muted)'
                          }}
                          title={file.invoiceLinked.verified ? 'Invoice verified' : 'Invoice not verified yet'}
                        >
                          {file.invoiceLinked.verified ? 'Verified' : 'Not verified'}
                        </span>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {file.status === 'failed' ? (
                        <button className="button" onClick={() => void processFile(file.id)} disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}>
                          Retry
                        </button>
                      ) : null}
                      {file.status === 'queued' ? (
                        <button className="button button-primary" onClick={() => void processFile(file.id)} disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}>
                          Process Now
                        </button>
                      ) : null}
                      {file.status !== 'failed' && file.status !== 'queued' ? (
                        <button className="button" onClick={() => void processFile(file.id)} disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}>
                          Process
                        </button>
                      ) : null}
                      <button className="button" onClick={() => void deleteFile(file.id)} disabled={busy} style={{ fontSize: 11, padding: '3px 8px', color: 'var(--color-danger)' }}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!busy && filteredFiles.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 32 }}>
                  {files.length === 0 ? 'No imported files found.' : 'No files match current filters.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}
