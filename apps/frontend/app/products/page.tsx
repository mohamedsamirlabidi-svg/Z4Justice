'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';
import { formatTND } from '../lib/format';

/* ── Types ───────────────────────────────── */

type Product = {
  id: string;
  name: string;
  description?: string | null;
  sku?: string | null;
  unitPrice: number;
  status?: string;
  createdAt?: string;
  _count?: { items: number };
};

type ProductStats = {
  total: number;
  noName: number;
  noSku: number;
  zeroPrice: number;
  duplicates: number;
  pending: number;
  verified: number;
};

type CleanupResult = {
  removedDuplicates: number;
  removedIncomplete: number;
  total: number;
};

const EMPTY_FORM = { name: '', description: '', sku: '', unitPrice: '0' };

/* ── Component ───────────────────────────── */

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [stats, setStats] = useState<ProductStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_FORM);
  const [sortKey, setSortKey] = useState<'name' | 'sku' | 'unitPrice' | 'createdAt'>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'verified'>('all');

  /* ── Data loading ── */

  const loadProducts = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [data, statsData] = await Promise.all([
        apiRequest<Product[]>(`/products?search=${encodeURIComponent(search)}`),
        apiRequest<ProductStats>('/products/stats'),
      ]);
      setProducts(data);
      setStats(statsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load products');
    } finally {
      setBusy(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => { void loadProducts(); }, 500);
    return () => clearTimeout(t);
  }, [loadProducts]);

  /* ── Sorted list ── */

  const sorted = useMemo(() => {
    let copy = [...products];
    if (statusFilter !== 'all') {
      copy = copy.filter((p) => (p.status || 'pending') === statusFilter);
    }
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = (a.name || '').localeCompare(b.name || '');
      else if (sortKey === 'sku') cmp = (a.sku || '').localeCompare(b.sku || '');
      else if (sortKey === 'unitPrice') cmp = (a.unitPrice || 0) - (b.unitPrice || 0);
      else cmp = (a.createdAt || '').localeCompare(b.createdAt || '');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [products, sortKey, sortDir, statusFilter]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  function sortIcon(key: typeof sortKey) {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  async function toggleStatus(id: string, currentStatus: string) {
    setBusy(true); setError(''); setMessage('');
    const newStatus = currentStatus === 'verified' ? 'pending' : 'verified';
    try {
      await apiRequest(`/products/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      setMessage(`Product marked as ${newStatus}.`);
      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status update failed');
    } finally {
      setBusy(false);
    }
  }

  /* ── CRUD ── */

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest('/products', {
        method: 'POST',
        body: JSON.stringify({ ...createForm, unitPrice: Number(createForm.unitPrice) }),
      });
      setCreateForm(EMPTY_FORM);
      setShowCreate(false);
      setMessage('Product created successfully.');
      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(p: Product) {
    setEditingId(p.id);
    setEditForm({
      name: p.name || '',
      description: p.description || '',
      sku: p.sku || '',
      unitPrice: String(p.unitPrice ?? 0),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(EMPTY_FORM);
  }

  async function saveEdit() {
    if (!editingId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest(`/products/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...editForm, unitPrice: Number(editForm.unitPrice) }),
      });
      setEditingId(null);
      setMessage('Product updated.');
      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteProduct(id: string) {
    if (!confirm('Delete this product? This cannot be undone.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest(`/products/${id}`, { method: 'DELETE' });
      setMessage('Product deleted.');
      if (editingId === id) cancelEdit();
      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  async function runCleanup() {
    if (!confirm('This will permanently remove duplicate products and products with missing data (name or price). Products linked to invoices will not be touched. Continue?')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await apiRequest<CleanupResult>('/products/cleanup', { method: 'POST' });
      setMessage(`Cleanup complete: ${result.removedDuplicates} duplicates removed, ${result.removedIncomplete} incomplete removed (${result.total} total).`);
      await loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setBusy(false);
    }
  }

  /* ── Quality flags ── */

  function qualityFlags(p: Product): string[] {
    const flags: string[] = [];
    if (!p.name || !p.name.trim()) flags.push('No name');
    if (!p.sku) flags.push('No SKU');
    if (!p.unitPrice || p.unitPrice <= 0) flags.push('No price');
    return flags;
  }

  const issues = stats ? stats.noName + stats.noSku + stats.zeroPrice + stats.duplicates : 0;

  /* ── Render ── */

  return (
    <main>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Products</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 13 }}>
            Manage your product catalog · <strong>{products.length}</strong> products
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="button" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? '✕ Cancel' : '＋ New Product'}
          </button>
          <button className="button button-primary" onClick={() => void loadProducts()} disabled={busy}>
            {busy ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Stats KPI Row */}
      {stats ? (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
          <div className="kpi-card" style={{ borderLeftColor: 'var(--color-primary-light)' }}>
            <span className="kpi-title">Total</span>
            <span className="kpi-value" style={{ fontSize: 22 }}>{stats.total}</span>
          </div>
          <div className="kpi-card" style={{ borderLeftColor: 'var(--color-success)', cursor: 'pointer' }} onClick={() => setStatusFilter((f) => f === 'verified' ? 'all' : 'verified')}>
            <span className="kpi-title">Verified ✓</span>
            <span className="kpi-value" style={{ fontSize: 22, color: 'var(--color-success)' }}>{stats.verified}</span>
          </div>
          <div className="kpi-card" style={{ borderLeftColor: '#f59e0b', cursor: 'pointer' }} onClick={() => setStatusFilter((f) => f === 'pending' ? 'all' : 'pending')}>
            <span className="kpi-title">Pending ⏳</span>
            <span className="kpi-value" style={{ fontSize: 22, color: '#f59e0b' }}>{stats.pending}</span>
          </div>
          <div className="kpi-card" style={{ borderLeftColor: stats.duplicates > 0 ? 'var(--color-warning)' : 'var(--color-success)' }}>
            <span className="kpi-title">Duplicates</span>
            <span className="kpi-value" style={{ fontSize: 22, color: stats.duplicates > 0 ? 'var(--color-warning)' : 'var(--color-success)' }}>{stats.duplicates}</span>
          </div>
          <div className="kpi-card" style={{ borderLeftColor: stats.zeroPrice > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>
            <span className="kpi-title">No Price</span>
            <span className="kpi-value" style={{ fontSize: 22, color: stats.zeroPrice > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>{stats.zeroPrice}</span>
          </div>
          <div className="kpi-card" style={{ borderLeftColor: stats.noSku > 0 ? 'var(--color-accent)' : 'var(--color-success)' }}>
            <span className="kpi-title">No SKU</span>
            <span className="kpi-value" style={{ fontSize: 22, color: stats.noSku > 0 ? 'var(--color-accent)' : 'var(--color-success)' }}>{stats.noSku}</span>
          </div>
        </section>
      ) : null}

      {/* Cleanup Banner */}
      {issues > 0 ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 'var(--radius-sm)',
          padding: '10px 16px', marginBottom: 16, fontSize: 13,
        }}>
          <span>
            ⚠️ <strong>{issues} issues</strong> found ({stats?.duplicates ?? 0} duplicates, {stats?.zeroPrice ?? 0} no price, {stats?.noSku ?? 0} no SKU).
          </span>
          <button className="button" onClick={() => void runCleanup()} disabled={busy} style={{ fontSize: 12, padding: '4px 12px' }}>
            🧹 Auto-Cleanup
          </button>
        </div>
      ) : null}

      {/* Messages */}
      {message ? <div style={{ color: 'var(--color-success)', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius-sm)' }}>{message}</div> : null}
      {error ? <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius-sm)' }}>{error}</div> : null}

      {/* Create Form (slide down) */}
      {showCreate ? (
        <section className="card" style={{ padding: 20, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700 }}>Add New Product</h3>
          <form onSubmit={createProduct} style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1.5fr 1fr auto', gap: 10, alignItems: 'end' }}>
            <div>
              <label style={labelStyle}>Name *</label>
              <input className="input" style={{ width: '100%' }} placeholder="Product name" value={createForm.name} onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))} required />
            </div>
            <div>
              <label style={labelStyle}>Description</label>
              <input className="input" style={{ width: '100%' }} placeholder="Description" value={createForm.description} onChange={(e) => setCreateForm((p) => ({ ...p, description: e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Référence (SKU)</label>
              <input className="input" style={{ width: '100%' }} placeholder="REF-001" value={createForm.sku} onChange={(e) => setCreateForm((p) => ({ ...p, sku: e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Price (DT)</label>
              <input className="input" style={{ width: '100%' }} type="number" step="0.001" min="0" placeholder="0.000" value={createForm.unitPrice} onChange={(e) => setCreateForm((p) => ({ ...p, unitPrice: e.target.value }))} required />
            </div>
            <button className="button button-primary" type="submit" disabled={busy} style={{ height: 38 }}>
              Add
            </button>
          </form>
        </section>
      ) : null}

      {/* Search + Status Filter */}
      <section style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: 1, maxWidth: 420 }}
          placeholder="🔍 Search by name, SKU or description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {statusFilter !== 'all' ? (
          <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 12, background: statusFilter === 'verified' ? '#dcfce7' : '#fef3c7', color: statusFilter === 'verified' ? '#166534' : '#92400e', fontWeight: 600, cursor: 'pointer' }} onClick={() => setStatusFilter('all')}>
            Showing: {statusFilter} ✕
          </span>
        ) : null}
      </section>

      {/* Products Table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('sku')}>
                SKU{sortIcon('sku')}
              </th>
              <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('name')}>
                Name{sortIcon('name')}
              </th>
              <th>Description</th>
              <th style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }} onClick={() => toggleSort('unitPrice')}>
                Unit Price{sortIcon('unitPrice')}
              </th>
              <th style={{ textAlign: 'center' }}>Invoices</th>
              <th style={{ textAlign: 'center' }}>Status</th>
              <th>Quality</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const isEditing = editingId === p.id;
              const flags = qualityFlags(p);
              const invoiceCount = p._count?.items ?? 0;

              if (isEditing) {
                return (
                  <tr key={p.id} style={{ background: 'var(--color-primary-soft)' }}>
                    <td>
                      <input className="input" style={{ width: 110, fontSize: 12 }} value={editForm.sku} onChange={(e) => setEditForm((f) => ({ ...f, sku: e.target.value }))} placeholder="SKU" />
                    </td>
                    <td>
                      <input className="input" style={{ width: '100%', fontSize: 12, fontWeight: 600 }} value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} placeholder="Name" required />
                    </td>
                    <td>
                      <input className="input" style={{ width: '100%', fontSize: 12 }} value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} placeholder="Description" />
                    </td>
                    <td>
                      <input className="input" style={{ width: 100, fontSize: 12, textAlign: 'right' }} type="number" step="0.001" min="0" value={editForm.unitPrice} onChange={(e) => setEditForm((f) => ({ ...f, unitPrice: e.target.value }))} />
                    </td>
                    <td style={{ textAlign: 'center' }}>{invoiceCount}</td>
                    <td />
                    <td />
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button className="button button-primary" onClick={() => void saveEdit()} disabled={busy} style={{ fontSize: 11, padding: '3px 10px' }}>Save</button>
                        <button className="button" onClick={cancelEdit} style={{ fontSize: 11, padding: '3px 10px' }}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={p.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: p.sku ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                    {p.sku || '—'}
                  </td>
                  <td style={{ fontWeight: 600 }}>{p.name || <span style={{ color: 'var(--color-danger)' }}>Unnamed</span>}</td>
                  <td style={{ color: 'var(--color-text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.description || '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatTND(p.unitPrice)}</td>
                  <td style={{ textAlign: 'center' }}>
                    {invoiceCount > 0 ? (
                      <span className="status-badge status-processed">{invoiceCount}</span>
                    ) : (
                      <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>0</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {(p.status || 'pending') === 'verified' ? (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#dcfce7', color: '#166534', fontWeight: 600, cursor: 'pointer' }} onClick={() => void toggleStatus(p.id, 'verified')} title="Click to mark as pending">✓ Verified</span>
                    ) : (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#fef3c7', color: '#92400e', fontWeight: 600, cursor: 'pointer' }} onClick={() => void toggleStatus(p.id, 'pending')} title="Click to verify">⏳ Pending</span>
                    )}
                  </td>
                  <td>
                    {flags.length > 0 ? (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {flags.map((f) => (
                          <span key={f} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 10, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>{f}</span>
                        ))}
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-success)' }}>✓ Complete</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      <button className="button" onClick={() => startEdit(p)} disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}>✏️ Edit</button>
                      <button className="button" onClick={() => void deleteProduct(p.id)} disabled={busy || invoiceCount > 0} title={invoiceCount > 0 ? 'Linked to invoices — cannot delete' : 'Delete product'} style={{ fontSize: 11, padding: '3px 8px', color: invoiceCount > 0 ? 'var(--color-text-muted)' : 'var(--color-danger)' }}>
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!busy && products.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 40 }}>
                  {search ? `No products matching "${search}"` : 'No products yet. Click "+ New Product" to get started.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Footer count */}
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-muted)' }}>
        Showing {sorted.length} of {stats?.total ?? products.length} products
        {search ? ` (filtered by "${search}")` : ''}
      </div>
    </main>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-muted)',
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};
