'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { backendBase } from '../lib/api';
import { formatTND } from '../lib/format';
import { FlagBadge } from '../components/FlagBadge';

type FlagColor = 'green' | 'yellow' | 'orange' | 'red' | 'none';

type UploadResult = {
  ok: boolean;
  importedFile?: { id: string; filename: string; fullPath: string };
  invoice?: {
    id: string;
    invoiceNo: string;
    date: string;
    dueDate: string | null;
    status: string;
    paymentStatus: string;
    flagStatus: FlagColor;
    currency: string;
    totalAmount: number;
    documentType: string | null;
    client: { id: string; name: string } | null;
    items?: Array<{ id: string; description?: string | null; quantity: number; unitPrice: number; lineTotal: number }>;
  } | null;
  message?: string;
};

export default function UploadPage() {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (file: File) => {
    setError('');
    setResult(null);
    setUploading(true);
    setProgress(10);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('mini-erm-token') : null;
      const form = new FormData();
      form.append('file', file);
      setProgress(30);
      const res = await fetch(`${backendBase}/files/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      setProgress(80);
      const text = await res.text();
      let data: UploadResult;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(text || `Server returned status ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(data.message || `Upload failed (${res.status})`);
      }
      setResult(data);
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setTimeout(() => setProgress(0), 800);
    }
  }, []);

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Import manuel
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>
            Glissez-déposez une facture, un devis ou un bon de livraison (PDF, Excel, CSV). Le fichier passe par le même moteur d’extraction que le dossier surveillé.
          </p>
        </div>
      </div>

      {/* Drop zone */}
      <section
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void upload(f);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--color-primary-light)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-card)',
          padding: '48px 24px',
          textAlign: 'center',
          background: dragOver ? 'var(--color-primary-soft)' : '#fff',
          cursor: uploading ? 'progress' : 'pointer',
          transition: 'all 0.15s',
          marginBottom: 20,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.xls,.xlsx,.csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <div style={{ fontSize: 48, marginBottom: 10, opacity: 0.5 }}>📄</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>
          {uploading ? 'Traitement en cours…' : dragOver ? 'Relâchez pour importer' : 'Glissez un fichier ici, ou cliquez pour sélectionner'}
        </div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
          Formats acceptés : PDF, XLS, XLSX, CSV — 25 MB max
        </div>
      </section>

      {progress > 0 ? (
        <div style={{ height: 4, background: 'var(--color-border-light)', borderRadius: 2, marginBottom: 20, overflow: 'hidden' }}>
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              background: 'var(--color-primary-light)',
              transition: 'width 0.25s',
            }}
          />
        </div>
      ) : null}

      {error ? (
        <div className="card" style={{ borderColor: '#fecaca', color: '#b91c1c', padding: 16, marginBottom: 20 }}>
          <strong>Échec :</strong> {error}
        </div>
      ) : null}

      {result?.ok && result.invoice ? (
        <ResultCard invoice={result.invoice} />
      ) : null}

      {result?.ok && !result.invoice ? (
        <div className="card" style={{ padding: 20, marginBottom: 20 }}>
          <strong>Fichier enregistré</strong> mais aucune facture n’a été extraite. L’extraction a peut-être échoué ou le fichier n’a pas le format attendu.
        </div>
      ) : null}
    </main>
  );
}

function ResultCard({ invoice }: { invoice: NonNullable<UploadResult['invoice']> }) {
  return (
    <section className="card" style={{ padding: '24px 28px', borderLeft: '4px solid var(--color-success)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: 'var(--color-success-soft)',
            color: 'var(--color-success)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 800,
          }}
        >
          ✓
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Facture extraite avec succès</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            L’invoice a été créée, flaguée automatiquement, et rattachée au client détecté.
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 14,
          marginBottom: 20,
        }}
      >
        <Tile label="Numéro" value={invoice.invoiceNo} />
        <Tile label="Type" value={(invoice.documentType ?? 'unknown').replace(/_/g, ' ')} />
        <Tile label="Client" value={invoice.client?.name ?? '(non détecté)'} />
        <Tile label="Émis le" value={new Date(invoice.date).toLocaleDateString('fr-TN')} />
        <Tile label="Échéance" value={invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString('fr-TN') : 'non définie'} />
        <Tile label="Montant total" value={formatTND(invoice.totalAmount)} />
        <div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
            Flag
          </div>
          <FlagBadge status={invoice.flagStatus} />
        </div>
      </div>

      {invoice.items && invoice.items.length > 0 ? (
        <div style={{ overflowX: 'auto', marginBottom: 20 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Ligne</th>
                <th style={{ textAlign: 'right' }}>Qté</th>
                <th style={{ textAlign: 'right' }}>PU</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.description ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{it.quantity}</td>
                  <td style={{ textAlign: 'right' }}>{formatTND(it.unitPrice)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatTND(it.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Link href={`/invoices/${invoice.id}`} className="button button-primary">
          Ouvrir la facture
        </Link>
        {invoice.client ? (
          <Link href={`/clients/${invoice.client.id}`} className="button button-ghost">
            Voir le client
          </Link>
        ) : null}
        <Link href="/monitoring" className="button button-ghost">
          Aller au monitoring
        </Link>
      </div>
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)' }}>{value}</div>
    </div>
  );
}
