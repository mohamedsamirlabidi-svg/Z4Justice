'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';
import { formatTND } from '../lib/format';
import { useAuth } from '../lib/auth';

type Product = {
  id: string;
  name: string;
  description?: string | null;
  sku?: string | null;
  unitPrice: number;
  status?: string;
  _count?: { items: number };
};

type StockEntry = {
  productId: string;
  qty: number;
  minLevel: number;
};

type StockMovement = {
  id: string;
  productId: string;
  type: 'in' | 'out' | 'adjustment';
  quantity: number;
  reason: string;
  date: string;
  userId?: string;
  userName?: string;
};

const STOCK_KEY = 'mini-erm-stock';
const MOVEMENTS_KEY = 'mini-erm-stock-movements';

function loadStock(): Record<string, StockEntry> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(STOCK_KEY) || '{}');
  } catch { return {}; }
}

function saveStock(data: Record<string, StockEntry>) {
  localStorage.setItem(STOCK_KEY, JSON.stringify(data));
}

function loadMovements(): StockMovement[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(MOVEMENTS_KEY) || '[]');
  } catch { return []; }
}

function saveMovements(data: StockMovement[]) {
  localStorage.setItem(MOVEMENTS_KEY, JSON.stringify(data));
}

type StockStatus = 'in-stock' | 'low-stock' | 'out-of-stock';

function getStockStatus(qty: number, minLevel: number): StockStatus {
  if (qty <= 0) return 'out-of-stock';
  if (qty <= minLevel) return 'low-stock';
  return 'in-stock';
}

const statusLabels: Record<StockStatus, string> = {
  'in-stock': 'En stock',
  'low-stock': 'Stock faible',
  'out-of-stock': 'Rupture',
};

const statusColors: Record<StockStatus, { bg: string; color: string }> = {
  'in-stock': { bg: '#dcfce7', color: '#166534' },
  'low-stock': { bg: '#fef3c7', color: '#92400e' },
  'out-of-stock': { bg: '#fee2e2', color: '#991b1b' },
};

export default function StockPage() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [products, setProducts] = useState<Product[]>([]);
  const [stock, setStock] = useState<Record<string, StockEntry>>({});
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | StockStatus>('all');
  const [adjustModal, setAdjustModal] = useState<{ productId: string; name: string } | null>(null);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustType, setAdjustType] = useState<'in' | 'out' | 'adjustment'>('in');
  const [adjustReason, setAdjustReason] = useState('');
  const [historyProduct, setHistoryProduct] = useState<string | null>(null);
  const [showAddStock, setShowAddStock] = useState(false);
  const [addStockSearch, setAddStockSearch] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const data = await apiRequest<Product[]>('/products');
      setProducts(data);
      setStock(loadStock());
      setMovements(loadMovements());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const enriched = useMemo(() => {
    return products.map((p) => {
      const entry = stock[p.id] || { productId: p.id, qty: 0, minLevel: 5 };
      const status = getStockStatus(entry.qty, entry.minLevel);
      return { ...p, stockQty: entry.qty, minLevel: entry.minLevel, stockStatus: status };
    });
  }, [products, stock]);

  // Main table: only products with stock > 0 (not rupture)
  const filtered = useMemo(() => {
    let items = enriched.filter((p) => p.stockQty > 0);
    if (search) {
      const q = search.toLowerCase();
      items = items.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    }
    if (filter !== 'all') {
      items = items.filter((p) => p.stockStatus === filter);
    }
    return items;
  }, [enriched, search, filter]);

  // "Add Stock" modal: show all products, searchable, prioritize rupture
  const addStockResults = useMemo(() => {
    if (!showAddStock) return [];
    let items = enriched;
    if (addStockSearch) {
      const q = addStockSearch.toLowerCase();
      items = items.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    }
    // Sort: rupture first, then low-stock, then in-stock
    const order: Record<StockStatus, number> = { 'out-of-stock': 0, 'low-stock': 1, 'in-stock': 2 };
    items.sort((a, b) => order[a.stockStatus] - order[b.stockStatus]);
    return items.slice(0, 50);
  }, [enriched, showAddStock, addStockSearch]);

  const stats = useMemo(() => {
    const withStock = enriched.filter((p) => p.stockQty > 0);
    const total = withStock.length;
    const inStock = withStock.filter((p) => p.stockStatus === 'in-stock').length;
    const low = withStock.filter((p) => p.stockStatus === 'low-stock').length;
    const out = enriched.filter((p) => p.stockStatus === 'out-of-stock').length;
    const totalValue = withStock.reduce((sum, p) => sum + p.stockQty * p.unitPrice, 0);
    return { total, inStock, low, out, totalValue };
  }, [enriched]);

  function doAdjust() {
    if (!adjustModal) return;
    const qty = parseFloat(adjustQty);
    if (!Number.isFinite(qty) || qty <= 0) return;

    const current = stock[adjustModal.productId] || { productId: adjustModal.productId, qty: 0, minLevel: 5 };
    let newQty = current.qty;
    if (adjustType === 'in') newQty += qty;
    else if (adjustType === 'out') newQty = Math.max(0, newQty - qty);
    else newQty = qty;

    const updated = { ...stock, [adjustModal.productId]: { ...current, qty: newQty } };
    setStock(updated);
    saveStock(updated);

    const movement: StockMovement = {
      id: Date.now().toString(36),
      productId: adjustModal.productId,
      type: adjustType,
      quantity: qty,
      reason: adjustReason || adjustType,
      date: new Date().toISOString(),
      userId: user?.id,
      userName: user?.name,
    };
    const newMovements = [movement, ...movements];
    setMovements(newMovements);
    saveMovements(newMovements);

    setAdjustModal(null);
    setAdjustQty('');
    setAdjustReason('');
  }

  function setMinLevel(productId: string, minLevel: number) {
    const current = stock[productId] || { productId, qty: 0, minLevel: 5 };
    const updated = { ...stock, [productId]: { ...current, minLevel } };
    setStock(updated);
    saveStock(updated);
  }

  const productMovements = historyProduct
    ? movements.filter((m) => m.productId === historyProduct)
    : [];

  return (
    <main>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Gestion de Stock
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>
            Suivi des quantités et mouvements de stock
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canManage && (
            <button className="button button-success button-sm" onClick={() => { setShowAddStock(true); setAddStockSearch(''); }}>
              + Ajouter Stock
            </button>
          )}
          <button className="button button-primary button-sm" onClick={() => void load()} disabled={busy}>
            {busy ? 'Chargement…' : '↻ Actualiser'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: '#fecaca', color: '#b91c1c', padding: 16, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* KPI Cards */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#eff6ff', color: '#3b82f6' }}>📦</div>
          <div className="kpi-content">
            <div className="kpi-title">Total Produits</div>
            <div className="kpi-value">{stats.total}</div>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#f0fdf4', color: '#16a34a' }}>✓</div>
          <div className="kpi-content">
            <div className="kpi-title">En Stock</div>
            <div className="kpi-value">{stats.inStock}</div>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#fffbeb', color: '#d97706' }}>⚠</div>
          <div className="kpi-content">
            <div className="kpi-title">Stock Faible</div>
            <div className="kpi-value">{stats.low}</div>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#fef2f2', color: '#dc2626' }}>✕</div>
          <div className="kpi-content">
            <div className="kpi-title">Rupture</div>
            <div className="kpi-value">{stats.out}</div>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#f0fdf4', color: '#16a34a' }}>💰</div>
          <div className="kpi-content">
            <div className="kpi-title">Valeur</div>
            <div className="kpi-value" style={{ fontSize: '1.2rem' }}>{formatTND(stats.totalValue)}</div>
          </div>
        </div>
      </section>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          placeholder="Rechercher produit en stock…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260 }}
        />
        {(['all', 'in-stock', 'low-stock'] as const).map((f) => (
          <button
            key={f}
            className={`chip ${filter === f ? 'chip-active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Tous en stock' : statusLabels[f]}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--color-text-muted)' }}>
          {filtered.length} produit{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Stock Table */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 24 }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ border: 'none' }}>
            <thead>
              <tr>
                <th>Produit</th>
                <th>SKU</th>
                <th>P.U.</th>
                <th>Stock</th>
                <th>Min.</th>
                <th>Statut</th>
                <th>Valeur</th>
                <th style={{ textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const sColor = statusColors[p.stockStatus];
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                      {p.description && (
                        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                          {p.description.slice(0, 50)}
                        </div>
                      )}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--color-text-muted)' }}>
                      {p.sku || '—'}
                    </td>
                    <td>{formatTND(p.unitPrice)}</td>
                    <td>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>{p.stockQty}</span>
                    </td>
                    <td>
                      {canManage ? (
                        <input
                          type="number"
                          className="input"
                          value={p.minLevel}
                          onChange={(e) => setMinLevel(p.id, Math.max(0, parseInt(e.target.value) || 0))}
                          style={{ width: 60, padding: '4px 6px', fontSize: 13, textAlign: 'center' }}
                          min={0}
                        />
                      ) : (
                        <span style={{ fontSize: 13 }}>{p.minLevel}</span>
                      )}
                    </td>
                    <td>
                      <span style={{ ...sColor, padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                        {statusLabels[p.stockStatus]}
                      </span>
                    </td>
                    <td style={{ fontSize: 13 }}>{formatTND(p.stockQty * p.unitPrice)}</td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                        {canManage && (
                          <button
                            className="stock-action-btn"
                            title="Entrée stock"
                            onClick={() => { setAdjustModal({ productId: p.id, name: p.name }); setAdjustType('in'); }}
                          >
                            <span style={{ color: 'var(--color-success)' }}>+</span>
                          </button>
                        )}
                        <button
                          className="stock-action-btn"
                          title="Sortie stock"
                          onClick={() => { setAdjustModal({ productId: p.id, name: p.name }); setAdjustType('out'); }}
                        >
                          <span style={{ color: 'var(--color-danger)' }}>−</span>
                        </button>
                        <button
                          className="stock-action-btn"
                          title="Historique"
                          onClick={() => setHistoryProduct(historyProduct === p.id ? null : p.id)}
                        >
                          ↕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 32 }}>
                    Aucun produit trouvé
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Movement History (inline) */}
      {historyProduct && (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              Historique — {enriched.find((p) => p.id === historyProduct)?.name}
            </h3>
            <button className="button button-ghost button-sm" onClick={() => setHistoryProduct(null)}>✕ Fermer</button>
          </div>
          {productMovements.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>Aucun mouvement enregistré</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Date</th><th>Utilisateur</th><th>Type</th><th>Quantité</th><th>Raison</th></tr>
              </thead>
              <tbody>
                {productMovements.slice(0, 20).map((m) => (
                  <tr key={m.id}>
                    <td>{new Date(m.date).toLocaleString('fr-TN')}</td>
                    <td style={{ fontSize: 13 }}>{m.userName || '—'}</td>
                    <td>
                      <span className={m.type === 'in' ? 'stock-movement-in' : m.type === 'out' ? 'stock-movement-out' : ''} style={{ fontWeight: 600 }}>
                        {m.type === 'in' ? '↑ Entrée' : m.type === 'out' ? '↓ Sortie' : '⟳ Ajustement'}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {m.type === 'out' ? '−' : '+'}{m.quantity}
                    </td>
                    <td style={{ color: 'var(--color-text-muted)' }}>{m.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Add Stock Modal */}
      {showAddStock && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 100, paddingTop: 60 }} onClick={() => setShowAddStock(false)}>
          <div className="card" style={{ padding: 0, width: 560, maxWidth: '95vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '20px 24px 12px', borderBottom: '1px solid var(--color-border-light)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Ajouter Stock</h3>
                <button className="button button-ghost button-sm" onClick={() => setShowAddStock(false)}>✕</button>
              </div>
              <input
                className="input"
                placeholder="Rechercher un produit par nom, SKU…"
                value={addStockSearch}
                onChange={(e) => setAddStockSearch(e.target.value)}
                style={{ width: '100%' }}
                autoFocus
              />
              <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
                Produits en rupture affichés en premier · {addStockResults.length} résultat{addStockResults.length !== 1 ? 's' : ''}
              </p>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {addStockResults.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-muted)' }}>Aucun produit trouvé</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {addStockResults.map((p) => {
                    const sColor = statusColors[p.stockStatus];
                    return (
                      <div
                        key={p.id}
                        style={{
                          padding: '12px 24px',
                          borderBottom: '1px solid var(--color-border-light)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', gap: 8, marginTop: 2 }}>
                            {p.sku && <span style={{ fontFamily: 'monospace' }}>{p.sku}</span>}
                            <span>{formatTND(p.unitPrice)}</span>
                            <span>Stock: {p.stockQty}</span>
                          </div>
                        </div>
                        <span style={{ ...sColor, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                          {statusLabels[p.stockStatus]}
                        </span>
                        <button
                          className="button button-success button-sm"
                          onClick={() => {
                            setShowAddStock(false);
                            setAdjustModal({ productId: p.id, name: p.name });
                            setAdjustType('in');
                            setAdjustQty('');
                            setAdjustReason('');
                          }}
                        >
                          + Stock
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Adjustment Modal */}
      {adjustModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setAdjustModal(null)}>
          <div className="card" style={{ padding: 24, width: 400, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>
              {adjustType === 'in' ? 'Entrée stock' : adjustType === 'out' ? 'Sortie stock' : 'Ajustement'}
            </h3>
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: '0 0 16px' }}>{adjustModal.name}</p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {canManage && (
                <button key="in" className={`chip ${adjustType === 'in' ? 'chip-active' : ''}`} onClick={() => setAdjustType('in')}>
                  ↑ Entrée
                </button>
              )}
              <button key="out" className={`chip ${adjustType === 'out' ? 'chip-active' : ''}`} onClick={() => setAdjustType('out')}>
                ↓ Sortie
              </button>
              {canManage && (
                <button key="adjustment" className={`chip ${adjustType === 'adjustment' ? 'chip-active' : ''}`} onClick={() => setAdjustType('adjustment')}>
                  ⟳ Ajuster
                </button>
              )}
            </div>

            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-muted)' }}>Quantité</label>
            <input className="input" type="number" min="1" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} placeholder="Quantité" style={{ width: '100%', marginBottom: 12 }} autoFocus />

            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-muted)' }}>Raison (optionnel)</label>
            <input className="input" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="Achat, vente, retour…" style={{ width: '100%', marginBottom: 16 }} />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="button" onClick={() => setAdjustModal(null)}>Annuler</button>
              <button className="button button-primary" onClick={doAdjust} disabled={!adjustQty || parseFloat(adjustQty) <= 0}>
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}