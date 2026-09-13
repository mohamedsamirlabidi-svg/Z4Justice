'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
};

type MintResponse = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  key: string;
  warning: string;
};

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [justMinted, setJustMinted] = useState<MintResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const data = await apiRequest<ApiKey[]>('/api-keys');
      setKeys(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    if (!newName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await apiRequest<MintResponse>('/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      setJustMinted(created);
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mint key');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this API key? Any agent using it will start getting 401s immediately.')) return;
    setBusy(true);
    try {
      await apiRequest(`/api-keys/${id}/revoke`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke');
    } finally {
      setBusy(false);
    }
  }

  async function hardDelete(id: string) {
    if (!confirm('Permanently delete this key record? Audit trail will be lost. Prefer revoke.')) return;
    setBusy(true);
    try {
      await apiRequest(`/api-keys/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!justMinted?.key) return;
    try {
      await navigator.clipboard.writeText(justMinted.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore — user can select and copy manually */
    }
  }

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Clés API des agents
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>
            Une clé par machine ou intégration. Les clés authentifient l’agent Python d’ingestion et toute future intégration serveur-à-serveur.
          </p>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: '#fecaca', color: '#b91c1c', padding: 16, marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {justMinted ? (
        <div
          className="card"
          style={{
            padding: '16px 20px',
            marginBottom: 24,
            borderLeft: '4px solid var(--color-accent)',
            background: '#fffbeb',
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6 }}>
            <strong style={{ color: 'var(--color-text)' }}>Nouvelle clé créée :</strong> {justMinted.name}
          </div>
          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              background: '#fff',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              wordBreak: 'break-all',
              marginBottom: 10,
            }}
          >
            {justMinted.key}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="button button-primary button-sm" onClick={copyKey}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button className="button button-ghost button-sm" onClick={() => setJustMinted(null)}>
              I saved it — dismiss
            </button>
            <span style={{ fontSize: 12, color: '#b45309' }}>
              {justMinted.warning}
            </span>
          </div>
        </div>
      ) : null}

      <section className="card" style={{ padding: '20px 24px', marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Mint a new key</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="text"
            className="input"
            placeholder="Label (e.g. Office laptop, IT lab machine)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1, maxWidth: 420 }}
          />
          <button
            className="button button-primary"
            onClick={mint}
            disabled={busy || !newName.trim()}
          >
            {busy ? 'Working…' : 'Mint key'}
          </button>
        </div>
      </section>

      <section className="card" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Existing keys</h3>
          <button className="button button-ghost button-sm" onClick={() => void load()} disabled={busy}>
            ↻ Refresh
          </button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Prefix</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th style={{ width: 200 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const revoked = Boolean(k.revokedAt);
                return (
                  <tr key={k.id} style={{ opacity: revoked ? 0.55 : 1 }}>
                    <td>{k.name}</td>
                    <td>
                      <code style={{ fontSize: 12 }}>{k.keyPrefix}…</code>
                    </td>
                    <td>{new Date(k.createdAt).toLocaleString('fr-TN')}</td>
                    <td>
                      {k.lastUsedAt ? (
                        new Date(k.lastUsedAt).toLocaleString('fr-TN')
                      ) : (
                        <span style={{ color: 'var(--color-text-light)' }}>never</span>
                      )}
                    </td>
                    <td>
                      {revoked ? (
                        <span style={{ color: 'var(--color-danger)', fontWeight: 600, fontSize: 12 }}>
                          Revoked {new Date(k.revokedAt!).toLocaleDateString('fr-TN')}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--color-success)', fontWeight: 600, fontSize: 12 }}>
                          Active
                        </span>
                      )}
                    </td>
                    <td>
                      {!revoked ? (
                        <button
                          className="button button-ghost button-sm"
                          style={{ color: 'var(--color-danger)' }}
                          onClick={() => void revoke(k.id)}
                          disabled={busy}
                        >
                          Revoke
                        </button>
                      ) : null}
                      <button
                        className="button button-ghost button-sm"
                        style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}
                        onClick={() => void hardDelete(k.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
              {keys.length === 0 && !busy ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 24 }}>
                    No API keys yet. Mint one above to authenticate an ingestion agent.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
