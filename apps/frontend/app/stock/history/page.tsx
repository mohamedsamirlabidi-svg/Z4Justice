'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api';

type Product = {
  id: string;
  name: string;
  sku?: string | null;
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

const MOVEMENTS_KEY = 'mini-erm-stock-movements';

function loadMovements(): StockMovement[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(MOVEMENTS_KEY) || '[]');
  } catch { return []; }
}

const typeLabels: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  in: { label: 'Entrée', icon: '↑', color: '#166534', bg: '#dcfce7' },
  out: { label: 'Sortie', icon: '↓', color: '#991b1b', bg: '#fee2e2' },
  adjustment: { label: 'Ajustement', icon: '⟳', color: '#92400e', bg: '#fef3c7' },
};

export default function StockHistoryPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'in' | 'out' | 'adjustment'>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiRequest<Product[]>('/products');
      setProducts(data);
    } catch { /* ignore */ }
    setMovements(loadMovements());
  }, []);

  useEffect(() => { void load(); }, [load]);

  const productMap = useMemo(() => {
    const map: Record<string, Product> = {};
    products.forEach((p) => { map[p.id] = p; });
    return map;
  }, [products]);

  const filtered = useMemo(() => {
    let items = [...movements];

    if (typeFilter !== 'all') {
      items = items.filter((m) => m.type === typeFilter);
    }

    if (search) {
      const q = search.toLowerCase();
      items = items.filter((m) => {
        const p = productMap[m.productId];
        return (
          (p?.name || '').toLowerCase().includes(q) ||
          (p?.sku || '').toLowerCase().includes(q) ||
          (m.userName || '').toLowerCase().includes(q) ||
          m.reason.toLowerCase().includes(q)
        );
      });
    }

    if (dateFrom) {
      const from = new Date(dateFrom);
      items = items.filter((m) => new Date(m.date) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      items = items.filter((m) => new Date(m.date) <= to);
    }

    return items;
  }, [movements, typeFilter, search, dateFrom, dateTo, productMap]);

  const stats = useMemo(() => {
    const totalIn = filtered.filter((m) => m.type === 'in').reduce((s, m) => s + m.quantity, 0);
    const totalOut = filtered.filter((m) => m.type === 'out').reduce((s, m) => s + m.quantity, 0);
    return { total: filtered.length, totalIn, totalOut };
  }, [filtered]);

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Historique des Mouvements
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>
            Suivi des entrées et sorties de stock
          </p>
        </div>
      </div>

      {/* KPI summary */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#eff6ff', color: '#3b82f6' }}>📋</div>
          <div className="kpi-content">
            <div className="kpi-title">Opérations</div>
            <div className="kpi-value">{stats.total}</div>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#dcfce7', color: '#166534' }}>↑</div>
          <div className="kpi-content">
            <div className="kpi-title">Total Entrées</div>
            <div className="kpi-value">{stats.totalIn}</div>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon-box" style={{ background: '#fee2e2', color: '#991b1b' }}>↓</div>
          <div className="kpi-content">
            <div className="kpi-title">Total Sorties</div>
            <div className="kpi-value">{stats.totalOut}</div>
          </div>
        </div>
      </section>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          placeholder="Rechercher produit, raison…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
        {(['all', 'in', 'out', 'adjustment'] as const).map((f) => (
          <button
            key={f}
            className={`chip ${typeFilter === f ? 'chip-active' : ''}`}
            onClick={() => setTypeFilter(f)}
          >
            {f === 'all' ? 'Tous' : typeLabels[f].label}
          </button>
        ))}
        <input
          className="input"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          style={{ width: 150 }}
          title="Date début"
        />
        <input
          className="input"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          style={{ width: 150 }}
          title="Date fin"
        />
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--color-text-muted)' }}>
          {filtered.length} mouvement{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* History Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ border: 'none' }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Utilisateur</th>
                <th>Produit</th>
                <th>Type</th>
                <th>Quantité</th>
                <th>Raison</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const product = productMap[m.productId];
                const tl = typeLabels[m.type] || typeLabels.adjustment;
                return (
                  <tr key={m.id}>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                      {new Date(m.date).toLocaleString('fr-TN', {
                        day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </td>
                    <td style={{ fontSize: 13, fontWeight: 500 }}>{m.userName || '—'}</td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{product?.name || 'Produit inconnu'}</div>
                      {product?.sku && (
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>{product.sku}</div>
                      )}
                    </td>
                    <td>
                      <span style={{ background: tl.bg, color: tl.color, padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                        {tl.icon} {tl.label}
                      </span>
                    </td>
                    <td style={{ fontWeight: 700, fontSize: 15 }}>
                      <span style={{ color: m.type === 'out' ? 'var(--color-danger)' : 'var(--color-success)' }}>
                        {m.type === 'out' ? '−' : '+'}{m.quantity}
                      </span>
                    </td>
                    <td style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{m.reason || '—'}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 32 }}>
                    Aucun mouvement trouvé
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
