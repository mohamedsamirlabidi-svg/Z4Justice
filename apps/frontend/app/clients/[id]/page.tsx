'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { formatTND } from '../../lib/format';
import { FlagBadge } from '../../components/FlagBadge';

type FlagColor = 'green' | 'yellow' | 'orange' | 'red' | 'none';
type DocType = 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';

type ClientInvoice = {
  id: string;
  invoiceNo: string;
  date: string;
  dueDate: string | null;
  status: string;
  paymentStatus?: string;
  flagStatus?: FlagColor;
  currency: string;
  totalAmount: number;
  documentType?: DocType;
  lastNotifiedAt?: string | null;
  sourceFile?: string | null;
};

type ClientDetail = {
  id: string;
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  invoices: ClientInvoice[];
};

type NotifRow = {
  id: string;
  invoiceId: string;
  channel: string;
  recipient: string;
  status: string;
  templateKey: string | null;
  flagAtSend: string | null;
  contentPreview: string | null;
  createdAt: string;
};

type Tab = 'overview' | 'facture' | 'devis' | 'bon_de_livraison' | 'flags';

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  facture: 'Factures',
  devis: 'Devis',
  bon_de_livraison: 'Bons de livraison',
  flags: 'Flags & Reminders',
};

const CHANNEL_ICONS: Record<string, string> = {
  sms: '📱',
  email: '✉️',
  whatsapp: '💬',
  whatsapp_voice: '📞',
  legal_letter: '📜',
};

function normalizeDocType(t?: DocType | string | null): DocType {
  if (t === 'devis' || t === 'bon_de_livraison' || t === 'facture') return t;
  return 'facture';
}

function digitsOnly(s: string): string {
  return s.replace(/[^\d+]/g, '');
}

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const clientId = params?.id;
  const initialTab = (searchParams.get('tab') as Tab | null) ?? 'overview';

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [notifs, setNotifs] = useState<NotifRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [invoiceQuery, setInvoiceQuery] = useState('');

  const loadDetail = useCallback(async () => {
    if (!clientId) return;
    setBusy(true);
    setError('');
    try {
      const data = await apiRequest<ClientDetail>(`/clients/${clientId}`);
      setClient(data);
      const n = await apiRequest<{ rows: NotifRow[] }>(
        `/notifications?clientId=${clientId}&take=100`,
      );
      setNotifs(n.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load client detail');
    } finally {
      setBusy(false);
    }
  }, [clientId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const filteredInvoices = useMemo(() => {
    const q = invoiceQuery.trim().toLowerCase();
    let base = client?.invoices ?? [];
    if (tab === 'facture' || tab === 'devis' || tab === 'bon_de_livraison') {
      base = base.filter((inv) => normalizeDocType(inv.documentType) === tab);
    }
    if (q) {
      base = base.filter((inv) => inv.invoiceNo.toLowerCase().includes(q));
    }
    return base;
  }, [client?.invoices, tab, invoiceQuery]);

  const summary = useMemo(() => {
    const all = client?.invoices ?? [];
    const totalBilled = all.reduce((sum, inv) => sum + Number(inv.totalAmount || 0), 0);
    const outstanding = all
      .filter((inv) => (inv.paymentStatus ?? inv.status ?? '').toLowerCase() !== 'paid')
      .reduce((sum, inv) => sum + Number(inv.totalAmount || 0), 0);

    const flagCounts: Record<FlagColor, number> = { green: 0, yellow: 0, orange: 0, red: 0, none: 0 };
    for (const inv of all) {
      const f = (inv.flagStatus ?? 'none') as FlagColor;
      if (f in flagCounts) flagCounts[f] += 1;
      else flagCounts.none += 1;
    }
    return { totalInvoices: all.length, totalBilled, outstanding, flagCounts };
  }, [client?.invoices]);

  const invoicesByFlag = useMemo(() => {
    const buckets: Record<FlagColor, ClientInvoice[]> = { red: [], orange: [], yellow: [], green: [], none: [] };
    for (const inv of client?.invoices ?? []) {
      const f = (inv.flagStatus ?? 'none') as FlagColor;
      (buckets[f] ?? buckets.none).push(inv);
    }
    return buckets;
  }, [client?.invoices]);

  if (!client && !busy && !error) {
    return <main><p>Loading…</p></main>;
  }

  return (
    <main>
      <Link href="/clients" className="chip" style={{ marginBottom: 16, display: 'inline-block' }}>
        ← Retour aux clients
      </Link>

      {error ? (
        <div className="card" style={{ borderColor: '#fecaca', color: '#b91c1c', padding: 16, marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {client ? (
        <>
          {/* ── Contact card ── */}
          <ContactCard client={client} />

          {/* ── Summary strip ── */}
          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 14,
              marginBottom: 20,
            }}
          >
            <SummaryTile label="Total facturé" value={formatTND(summary.totalBilled)} accent="var(--color-primary-light)" />
            <SummaryTile label="En attente" value={formatTND(summary.outstanding)} accent="var(--color-warning)" />
            <SummaryTile label="Documents" value={String(summary.totalInvoices)} accent="var(--color-secondary)" />
            <FlagSummaryTile counts={summary.flagCounts} />
          </section>

          {/* ── Tabs ── */}
          <nav
            style={{
              display: 'flex',
              gap: 4,
              borderBottom: '1px solid var(--color-border)',
              marginBottom: 20,
              overflowX: 'auto',
            }}
          >
            {(Object.keys(TAB_LABELS) as Tab[]).map((k) => {
              const active = tab === k;
              return (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: '10px 14px',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: active ? 700 : 500,
                    color: active ? 'var(--color-primary-light)' : 'var(--color-text-muted)',
                    borderBottom: active
                      ? '2px solid var(--color-primary-light)'
                      : '2px solid transparent',
                    marginBottom: -1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {TAB_LABELS[k]}
                </button>
              );
            })}
          </nav>

          {tab !== 'flags' ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <input
                  className="input"
                  placeholder="Rechercher un numéro de document…"
                  value={invoiceQuery}
                  onChange={(e) => setInvoiceQuery(e.target.value)}
                  style={{ maxWidth: 360 }}
                />
              </div>
              <InvoiceTable rows={filteredInvoices} />
            </>
          ) : (
            <FlagsAndReminders invoicesByFlag={invoicesByFlag} notifs={notifs} />
          )}
        </>
      ) : null}
    </main>
  );
}

function ContactCard({ client }: { client: ClientDetail }) {
  const phone = client.phone?.trim() || '';
  const email = client.email?.trim() || '';
  const wa = phone ? digitsOnly(phone).replace(/^\+/, '') : '';

  return (
    <section
      className="card"
      style={{
        padding: '22px 24px',
        marginBottom: 20,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: 20,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--color-primary-light), var(--color-primary))',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 22,
          fontWeight: 700,
        }}
      >
        {client.name.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: '-0.01em' }}>
          {client.name}
        </h1>
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13, color: 'var(--color-text-muted)' }}>
          {phone ? (
            <a href={`tel:${digitsOnly(phone)}`} style={{ color: 'inherit', textDecoration: 'none' }} title="Click to call">
              📞 {phone}
            </a>
          ) : (
            <span style={{ color: 'var(--color-text-light)' }}>📞 no phone</span>
          )}
          {email ? (
            <a href={`mailto:${email}`} style={{ color: 'inherit', textDecoration: 'none' }} title="Click to email">
              ✉️ {email}
            </a>
          ) : (
            <span style={{ color: 'var(--color-text-light)' }}>✉️ no email</span>
          )}
          {wa ? (
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }} title="Open WhatsApp">
              💬 WhatsApp
            </a>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {phone ? (
          <a className="button button-ghost button-sm" href={`tel:${digitsOnly(phone)}`}>Call</a>
        ) : null}
        {email ? (
          <a className="button button-ghost button-sm" href={`mailto:${email}`}>Email</a>
        ) : null}
        {wa ? (
          <a className="button button-primary button-sm" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        ) : null}
      </div>
    </section>
  );
}

function SummaryTile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <article
      className="card"
      style={{ padding: '18px 20px', borderLeft: `4px solid ${accent}` }}
    >
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800 }}>{value}</div>
    </article>
  );
}

function FlagSummaryTile({ counts }: { counts: Record<FlagColor, number> }) {
  return (
    <article
      className="card"
      style={{ padding: '18px 20px', borderLeft: '4px solid #dc2626' }}
    >
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Flag mix
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {counts.red > 0 && <FlagPill color="red" count={counts.red} />}
        {counts.orange > 0 && <FlagPill color="orange" count={counts.orange} />}
        {counts.yellow > 0 && <FlagPill color="yellow" count={counts.yellow} />}
        {counts.green > 0 && <FlagPill color="green" count={counts.green} />}
        {counts.none > 0 && <FlagPill color="none" count={counts.none} />}
        {counts.red + counts.orange + counts.yellow + counts.green + counts.none === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--color-text-light)' }}>—</span>
        ) : null}
      </div>
    </article>
  );
}

function FlagPill({ color, count }: { color: FlagColor; count: number }) {
  const bg = color === 'red' ? '#fee2e2' : color === 'orange' ? '#ffedd5' : color === 'yellow' ? '#fef9c3' : color === 'green' ? '#dcfce7' : '#f3f4f6';
  const fg = color === 'red' ? '#991b1b' : color === 'orange' ? '#9a3412' : color === 'yellow' ? '#854d0e' : color === 'green' ? '#166534' : '#4b5563';
  return (
    <span style={{ background: bg, color: fg, padding: '3px 8px', borderRadius: 12, fontSize: 12, fontWeight: 700 }}>
      {count} {color}
    </span>
  );
}

function InvoiceTable({ rows }: { rows: ClientInvoice[] }) {
  if (rows.length === 0) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>
        Aucun document.
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: '20px 24px', overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 100 }}>Flag</th>
            <th>Document</th>
            <th>Type</th>
            <th>Émis le</th>
            <th>Échéance</th>
            <th style={{ textAlign: 'right' }}>Montant</th>
            <th>Paiement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((inv) => (
            <tr key={inv.id}>
              <td><FlagBadge status={inv.flagStatus ?? 'none'} /></td>
              <td>
                <Link href={`/invoices/${inv.id}`} style={{ color: 'var(--color-primary-light)', fontWeight: 600, textDecoration: 'none' }}>
                  {inv.invoiceNo}
                </Link>
              </td>
              <td>
                <span className="chip" style={{ fontSize: 11 }}>
                  {(inv.documentType ?? 'unknown').replace(/_/g, ' ')}
                </span>
              </td>
              <td>{new Date(inv.date).toLocaleDateString('fr-TN')}</td>
              <td style={{ color: inv.dueDate ? undefined : 'var(--color-text-light)' }}>
                {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('fr-TN') : 'non définie'}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatTND(inv.totalAmount)}</td>
              <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {(inv.paymentStatus ?? 'not_declared').replace(/_/g, ' ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlagsAndReminders({
  invoicesByFlag,
  notifs,
}: {
  invoicesByFlag: Record<FlagColor, ClientInvoice[]>;
  notifs: NotifRow[];
}) {
  const sections: Array<{ color: FlagColor; label: string }> = [
    { color: 'red', label: 'Rouge — Plus d’1 mois de retard' },
    { color: 'orange', label: 'Orange — Entre 1 semaine et 1 mois de retard' },
    { color: 'yellow', label: 'Jaune — Récemment échu (≤ 7 jours)' },
    { color: 'none', label: 'À échoir ou sans date' },
    { color: 'green', label: 'Réglé' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20 }}>
      <section>
        {sections.map(({ color, label }) => {
          const invs = invoicesByFlag[color];
          if (invs.length === 0) return null;
          return (
            <div key={color} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <FlagBadge status={color} />
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{label}</span>
                <span style={{ fontSize: 12, color: 'var(--color-text-light)' }}>· {invs.length}</span>
              </div>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {invs.map((inv, idx) => (
                  <Link
                    href={`/invoices/${inv.id}`}
                    key={inv.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderTop: idx === 0 ? 'none' : '1px solid var(--color-border-light)',
                      color: 'inherit',
                      textDecoration: 'none',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{inv.invoiceNo}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        Échéance {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('fr-TN') : 'non définie'}
                        {inv.lastNotifiedAt ? ` · Dernière relance ${new Date(inv.lastNotifiedAt).toLocaleDateString('fr-TN')}` : ''}
                      </div>
                    </div>
                    <span className="chip" style={{ fontSize: 11 }}>{(inv.documentType ?? 'unknown').replace(/_/g, ' ')}</span>
                    <strong style={{ fontSize: 14 }}>{formatTND(inv.totalAmount)}</strong>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-muted)' }}>
          Timeline des relances
        </h3>
        {notifs.length === 0 ? (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
            Aucune notification enregistrée pour ce client.
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {notifs.map((n, idx) => (
              <div
                key={n.id}
                style={{
                  padding: '14px 16px',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--color-border-light)',
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto',
                  gap: 10,
                  alignItems: 'start',
                }}
              >
                <span style={{ fontSize: 18 }}>{CHANNEL_ICONS[n.channel] ?? '📩'}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {n.channel} — {n.templateKey ?? 'notification'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                    {n.recipient}
                    {n.flagAtSend ? <>{' '}·{' '}<FlagBadge status={n.flagAtSend} /></> : null}
                  </div>
                  {n.contentPreview ? (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic', lineHeight: 1.4 }}>
                      “{n.contentPreview.slice(0, 90)}{n.contentPreview.length > 90 ? '…' : ''}”
                    </div>
                  ) : null}
                </div>
                <span style={{ fontSize: 11, color: 'var(--color-text-light)', whiteSpace: 'nowrap' }}>
                  {new Date(n.createdAt).toLocaleDateString('fr-TN')}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
