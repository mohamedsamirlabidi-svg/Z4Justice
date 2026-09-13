'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatTND } from '../lib/format';
import { FlagBadge } from '../components/FlagBadge';
import {
  getDemoInvoiceById,
  getDemoMonitoringRows,
  type DemoAlertHistoryEntry,
  type DemoFlagColor,
  type DemoInvoiceDetail,
  type DemoMonitoringRow,
} from '../lib/demoInvoices';

type Filter = 'ALL' | DemoFlagColor | 'MISSING_DUE_DATE';
type AlertHistoryEntry = DemoAlertHistoryEntry;
type AlertChannel = DemoAlertHistoryEntry['channel'];
type DemoInvoiceRow = DemoMonitoringRow;

const FILTERS: Array<{ key: Filter; label: string; countKey?: FlagColor | 'missing' | 'total' }> = [
  { key: 'ALL', label: 'All', countKey: 'total' },
  { key: 'red', label: 'Red', countKey: 'red' },
  { key: 'orange', label: 'Orange', countKey: 'orange' },
  { key: 'yellow', label: 'Yellow', countKey: 'yellow' },
  { key: 'none', label: 'On time', countKey: 'none' },
  { key: 'green', label: 'Paid', countKey: 'green' },
  { key: 'MISSING_DUE_DATE', label: 'Missing due date', countKey: 'missing' },
];

const CARD_ACCENTS: Record<DemoFlagColor | 'missing' | 'total', string> = {
  red: '#dc2626',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#16a34a',
  none: '#9ca3af',
  missing: '#6b7280',
  total: 'var(--color-primary-light)',
};

function getAlertChannelLabel(channel: DemoAlertHistoryEntry['channel']) {
  if (channel === 'email') return 'Email';
  if (channel === 'sms') return 'SMS';
  return 'WhatsApp';
}

function formatDateTime(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('fr-TN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getAlertStateLabel(state: AlertHistoryEntry['deliveryState']) {
  if (state === 'delivered') return 'Delivered';
  if (state === 'opened') return 'Opened';
  return 'Sent';
}

function getAlertChannelIcon(channel: AlertChannel) {
  if (channel === 'email') return '✉️';
  if (channel === 'sms') return '💬';
  return '📱';
}

function getAlertStateColor(state: AlertHistoryEntry['deliveryState']) {
  if (state === 'opened') return '#16a34a';
  if (state === 'delivered') return '#2563eb';
  return '#6b7280';
}

function describeReason(invoice: DemoInvoiceRow) {
  if (invoice.flagStatus === 'red') return 'Late payment and missing due date';
  if (invoice.flagStatus === 'orange') return 'Due date is close and reminder is active';
  if (invoice.flagStatus === 'yellow') return 'Needs follow-up before the due date';
  if (invoice.flagStatus === 'green') return 'Payment completed and monitoring closed';
  return 'On-time invoice with no alert history yet';
}

export default function MonitoringPage() {
  const [filter, setFilter] = useState<Filter>('ALL');
  const demoInvoices = useMemo(() => getDemoMonitoringRows(), []);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>(demoInvoices[0]?.id ?? '');
  const [popupInvoiceId, setPopupInvoiceId] = useState<string | null>(demoInvoices[0]?.id ?? null);

  const summary = useMemo(() => {
    const counts: Record<DemoFlagColor, number> = { green: 0, yellow: 0, orange: 0, red: 0, none: 0 };
    let missingDueDate = 0;

    for (const row of demoInvoices) {
      counts[row.flagStatus] += 1;
      if (!row.dueDate) missingDueDate += 1;
    }

    return {
      counts,
      missingDueDate,
      totalActive: demoInvoices.length,
    };
  }, [demoInvoices]);

  const filteredRows = useMemo(() => {
    if (filter === 'ALL') return demoInvoices;
    if (filter === 'MISSING_DUE_DATE') return demoInvoices.filter((row) => !row.dueDate);
    return demoInvoices.filter((row) => row.flagStatus === filter);
  }, [demoInvoices, filter]);

  const selectedInvoice = useMemo(
    () => demoInvoices.find((row) => row.id === selectedInvoiceId) ?? null,
    [demoInvoices, selectedInvoiceId],
  );

  const popupInvoice = useMemo(
    () => demoInvoices.find((row) => row.id === popupInvoiceId) ?? null,
    [demoInvoices, popupInvoiceId],
  );

  const popupInvoiceDetail = useMemo<DemoInvoiceDetail | null>(
    () => getDemoInvoiceById(popupInvoiceId),
    [popupInvoiceId],
  );

  const cardCounts = useMemo(() => {
    return {
      red: summary.counts.red,
      orange: summary.counts.orange,
      yellow: summary.counts.yellow,
      green: summary.counts.green,
      none: summary.counts.none,
      missing: summary.missingDueDate,
      total: summary.totalActive,
    };
  }, [summary]);

  const selectedCount = filteredRows.length;

  function resetDemoView() {
    setFilter('ALL');
    setSelectedInvoiceId(demoInvoices[0]?.id ?? '');
    setPopupInvoiceId(demoInvoices[0]?.id ?? null);
  }

  function openPopup(row: DemoMonitoringRow) {
    setSelectedInvoiceId(row.id);
    setPopupInvoiceId(row.id);
  }

  function closePopup() {
    setPopupInvoiceId(null);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closePopup();
    }

    if (popupInvoiceId) {
      window.addEventListener('keydown', onKeyDown);
    }

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [popupInvoiceId]);

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Invoice Monitoring
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>
            Static demo data for recordings. Click any flag to open the alert notification history.
          </p>
        </div>
        <button
          className="button button-primary"
          onClick={resetDemoView}
        >
          ↻ Reset demo
        </button>
      </div>

      <div className="card" style={{ padding: '12px 16px', marginBottom: 16, background: 'var(--color-primary-soft)' }}>
        <strong style={{ fontSize: 13 }}>Demo mode:</strong>{' '}
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          the page runs entirely on static frontend data, so your screen recording stays consistent and offline-friendly.
        </span>
      </div>

      {/* Summary cards — clickable filters */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 16,
          marginBottom: 24,
        }}
      >
        {FILTERS.map((f) => {
          const count = f.countKey ? cardCounts[f.countKey] : 0;
          const accent = f.countKey ? CARD_ACCENTS[f.countKey] : CARD_ACCENTS.total;
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                background: active ? 'var(--color-primary-soft)' : 'var(--color-card)',
                border: active
                  ? '1px solid var(--color-primary-light)'
                  : '1px solid var(--color-border)',
                borderLeft: `4px solid ${accent}`,
                borderRadius: 'var(--radius-card)',
                boxShadow: 'var(--shadow-card)',
                padding: '18px 20px',
                textAlign: 'left',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                transition: 'transform 0.05s',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {f.label}
              </span>
              <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--color-text)' }}>
                {count}
              </span>
            </button>
          );
        })}
      </section>

      {/* Invoices table */}
      <section className="card" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {filter === 'ALL'
              ? 'All invoices'
              : filter === 'MISSING_DUE_DATE'
                ? 'Invoices with missing due date'
                : `Flag: ${filter}`}
          </h3>
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            Showing {selectedCount} row{selectedCount === 1 ? '' : 's'}
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Flag</th>
                <th>Invoice</th>
                <th>Client</th>
                <th>Type</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Amount</th>
                <th>Payment</th>
                <th>Alerts</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr
                  key={r.id}
                  style={selectedInvoiceId === r.id ? { background: 'var(--color-primary-soft)' } : undefined}
                >
                  <td>
                    <button
                      type="button"
                      onClick={() => openPopup(r)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                      aria-pressed={selectedInvoiceId === r.id}
                      aria-label={`Open alert history for ${r.invoiceNo}`}
                    >
                      <FlagBadge status={r.flagStatus} />
                    </button>
                  </td>
                  <td>
                    <Link href={`/invoices/${r.id}`} style={{ color: 'var(--color-primary-light)', fontWeight: 600, textDecoration: 'none' }}>
                      {r.invoiceNo}
                    </Link>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                      {r.lastAlertAt ? `Last alert ${formatDateTime(r.lastAlertAt)}` : 'No alerts sent yet'}
                    </div>
                  </td>
                  <td>{r.client?.name ?? '—'}</td>
                  <td>
                    <span className="chip" style={{ fontSize: 11 }}>
                      {(r.documentType ?? 'unknown').replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>{r.date ? new Date(r.date).toLocaleDateString('fr-TN') : '—'}</td>
                  <td style={{ color: r.dueDate ? undefined : 'var(--color-text-light)' }}>
                    {r.dueDate ? new Date(r.dueDate).toLocaleDateString('fr-TN') : 'not set'}
                  </td>
                  <td>{formatTND(r.totalAmount)}</td>
                  <td>{r.paymentStatus.replace(/_/g, ' ')}</td>
                  <td style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{r.alertHistory.length} sent</td>
                </tr>
              ))}
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 24 }}>
                    No invoices for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* Alert history detail */}
      <section className="card" style={{ marginTop: 20, padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              Historique des alertes envoyées
            </h3>
            <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
              {selectedInvoice
                ? `${selectedInvoice.invoiceNo} · ${selectedInvoice.client?.name ?? '—'} · ${describeReason(selectedInvoice)}`
                : 'Cliquez sur un flag pour voir la chronologie des notifications.'}
            </p>
          </div>
          <button className="chip" onClick={() => setSelectedInvoiceId('')} disabled={!selectedInvoice}>
            Clear selection
          </button>
        </div>

        {selectedInvoice ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>Flag actuel</div>
                <FlagBadge status={selectedInvoice.flagStatus} />
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
                  Updated {formatDateTime(selectedInvoice.flagUpdatedAt)}
                </div>
              </div>
              <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>Due date</div>
                <div style={{ fontWeight: 700 }}>{selectedInvoice.dueDate ? formatDateTime(selectedInvoice.dueDate) : 'Not set'}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>Payment status: {selectedInvoice.paymentStatus.replace(/_/g, ' ')}</div>
              </div>
              <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>Alert count</div>
                <div style={{ fontWeight: 800, fontSize: 22 }}>{selectedInvoice.alertHistory.length}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
                  {selectedInvoice.lastAlertAt ? `Last sent ${formatDateTime(selectedInvoice.lastAlertAt)}` : 'No alert sent yet'}
                </div>
              </div>
            </div>

            {selectedInvoice.alertHistory.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
                No notification was sent for this invoice yet.
              </div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {selectedInvoice.alertHistory.map((event, idx) => (
                  <div
                    key={event.id}
                    style={{
                      padding: '14px 16px',
                      borderTop: idx === 0 ? 'none' : '1px solid var(--color-border-light)',
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      gap: 10,
                      alignItems: 'start',
                    }}
                  >
                    <span style={{ fontSize: 18 }}>{getAlertChannelIcon(event.channel)}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>
                        {event.channel.toUpperCase()} · {event.templateKey}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                        {event.recipient}
                        {' '}· {getAlertStateLabel(event.deliveryState)}
                        {' '}·<span style={{ marginLeft: 6 }}><FlagBadge status={event.flagAtSend} /></span>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic', lineHeight: 1.45 }}>
                        “{event.contentPreview}”
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: getAlertStateColor(event.deliveryState), fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {getAlertStateLabel(event.deliveryState)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-light)', whiteSpace: 'nowrap', marginTop: 4 }}>
                        {formatDateTime(event.sentAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>
            No invoice selected.
          </div>
        )}
      </section>

      {/* Popup details */}
      {popupInvoice ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="popup-invoice-title"
          onClick={closePopup}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            className="card"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(980px, 100%)',
              maxHeight: '90vh',
              overflow: 'auto',
              padding: 24,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h3 id="popup-invoice-title" style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
                  Détails popup — {popupInvoice.invoiceNo}
                </h3>
                <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
                  {popupInvoice.flagStatus === 'red'
                    ? 'Red flag: mise en demeure envoyée et client affiché ci-dessous.'
                    : 'Popup details for the selected invoice.'}
                </p>
              </div>
              <button className="button" onClick={closePopup}>
                ✕ Close
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginBottom: 16 }}>
              <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>Invoice</div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{popupInvoice.invoiceNo}</div>
                <div style={{ marginTop: 8 }}><FlagBadge status={popupInvoice.flagStatus} /></div>
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--color-text-muted)' }}>
                  {popupInvoice.documentType?.replace(/_/g, ' ')} · {formatTND(popupInvoice.totalAmount)}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-light)' }}>
                  {popupInvoice.dueDate ? `Due ${formatDateTime(popupInvoice.dueDate)}` : 'No due date set'}
                </div>
              </div>

              <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>Client details</div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{popupInvoiceDetail?.client.name ?? popupInvoice.client?.name ?? '—'}</div>
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                  <div><strong>Company:</strong> {popupInvoiceDetail?.client.company ?? '—'}</div>
                  <div><strong>City:</strong> {popupInvoiceDetail?.client.city ?? '—'}</div>
                  <div><strong>Email:</strong> {popupInvoiceDetail?.client.email ?? '—'}</div>
                  <div><strong>Phone:</strong> {popupInvoiceDetail?.client.phone ?? '—'}</div>
                  <div><strong>Contact:</strong> {popupInvoiceDetail?.client.contactName ?? '—'}</div>
                  <div><strong>Tax ID:</strong> {popupInvoiceDetail?.client.taxId ?? '—'}</div>
                </div>
              </div>

              <div className="card" style={{ padding: 14, boxShadow: 'none' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>Alert summary</div>
                <div style={{ fontWeight: 800, fontSize: 22 }}>{popupInvoice.alertHistory.length}</div>
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
                  Last alert: {popupInvoice.lastAlertAt ? formatDateTime(popupInvoice.lastAlertAt) : 'none'}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-light)' }}>
                  {popupInvoiceDetail?.flagStatus === 'red'
                    ? 'Mise en demeure record available for the recording.'
                    : 'Standard monitoring entry.'}
                </div>
              </div>
            </div>

            {popupInvoiceDetail?.flagStatus === 'red' ? (
              <div className="card" style={{ padding: 14, marginBottom: 16, background: '#fff1f2', border: '1px solid #fecdd3' }}>
                <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9f1239', marginBottom: 6 }}>
                  Mise en demeure
                </div>
                <div style={{ fontSize: 13, color: '#9f1239', lineHeight: 1.55 }}>
                  The red flag record shows the official mise en demeure sent to the government contact and tracked here as demo evidence.
                </div>
              </div>
            ) : null}

            {popupInvoiceDetail?.miseEnDemeureDocument ? (
              <details className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }} open>
                <summary style={{ listStyle: 'none', cursor: 'pointer', padding: '14px 16px', fontWeight: 700, fontSize: 13, color: 'var(--color-primary-light)' }}>
                  Document généré — Mise en demeure
                </summary>
                <div style={{ borderTop: '1px solid var(--color-border-light)', background: '#fff', padding: 16 }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7, color: 'var(--color-text)' }}>
                    {popupInvoiceDetail.miseEnDemeureDocument}
                  </pre>
                </div>
              </details>
            ) : null}

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {popupInvoice.alertHistory.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>
                  No notification was sent for this invoice yet.
                </div>
              ) : (
                popupInvoice.alertHistory.map((event, idx) => (
                  <div
                    key={event.id}
                    style={{
                      padding: '14px 16px',
                      borderTop: idx === 0 ? 'none' : '1px solid var(--color-border-light)',
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      gap: 10,
                      alignItems: 'start',
                    }}
                  >
                    <span style={{ fontSize: 18 }}>{getAlertChannelIcon(event.channel)}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>
                        {getAlertChannelLabel(event.channel)} · {event.templateKey}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                        {event.recipient}
                        {' '}· {getAlertStateLabel(event.deliveryState)}
                        {' '}·<span style={{ marginLeft: 6 }}><FlagBadge status={event.flagAtSend} /></span>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic', lineHeight: 1.45 }}>
                        “{event.contentPreview}”
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: getAlertStateColor(event.deliveryState), fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {getAlertStateLabel(event.deliveryState)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-light)', whiteSpace: 'nowrap', marginTop: 4 }}>
                        {formatDateTime(event.sentAt)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
