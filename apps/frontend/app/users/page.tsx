'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { apiRequest } from '../lib/api';

type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
};

const roleLabels: Record<string, string> = {
  admin: 'Administrateur',
  manager: 'Manager',
  employee: 'Employé',
};

const roleColors: Record<string, { bg: string; color: string }> = {
  admin: { bg: '#eff6ff', color: '#1d4ed8' },
  manager: { bg: '#fef3c7', color: '#92400e' },
  employee: { bg: '#f0fdf4', color: '#166534' },
};

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'employee' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<User[]>('/users');
      setUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Access guard: only admin
  if (currentUser?.role !== 'admin') {
    return (
      <main>
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-muted)' }}>
          Accès réservé aux administrateurs.
        </div>
      </main>
    );
  }

  function openCreate() {
    setEditUser(null);
    setForm({ name: '', email: '', password: '', role: 'employee' });
    setFormError('');
    setShowModal(true);
  }

  function openEdit(u: User) {
    setEditUser(u);
    setForm({ name: u.name, email: u.email, password: '', role: u.role });
    setFormError('');
    setShowModal(true);
  }

  async function handleSave() {
    setFormError('');
    if (!form.name || !form.email || (!editUser && !form.password)) {
      setFormError('Tous les champs obligatoires doivent être remplis');
      return;
    }
    setSaving(true);
    try {
      if (editUser) {
        const body: Record<string, string> = { name: form.name, email: form.email, role: form.role };
        if (form.password) body.password = form.password;
        await apiRequest(`/users/${editUser.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await apiRequest('/users', {
          method: 'POST',
          body: JSON.stringify(form),
        });
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(u: User) {
    if (!confirm(`Supprimer l'utilisateur "${u.name}" ?`)) return;
    try {
      await apiRequest(`/users/${u.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erreur');
    }
  }

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Gestion des Utilisateurs
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: 14 }}>
            Gérer les comptes et les rôles d&apos;accès
          </p>
        </div>
        <button className="button button-primary button-sm" onClick={openCreate}>
          + Nouvel utilisateur
        </button>
      </div>

      {error && (
        <div className="card" style={{ borderColor: '#fecaca', color: '#b91c1c', padding: 16, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Users Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ border: 'none' }}>
            <thead>
              <tr>
                <th>Nom</th>
                <th>Email</th>
                <th>Rôle</th>
                <th>Créé le</th>
                <th style={{ textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const rc = roleColors[u.role] || roleColors.employee;
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.name}</td>
                    <td style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{u.email}</td>
                    <td>
                      <span style={{ ...rc, padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                        {roleLabels[u.role] || u.role}
                      </span>
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                      {new Date(u.createdAt).toLocaleDateString('fr-TN')}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                        <button className="button button-ghost button-sm" onClick={() => openEdit(u)}>
                          ✎ Modifier
                        </button>
                        {u.id !== currentUser?.id && (
                          <button
                            className="button button-ghost button-sm"
                            style={{ color: 'var(--color-danger)' }}
                            onClick={() => handleDelete(u)}
                          >
                            ✕ Supprimer
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 32 }}>
                    Aucun utilisateur
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setShowModal(false)}>
          <div className="card" style={{ padding: 24, width: 420, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>
              {editUser ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur'}
            </h3>

            {formError && (
              <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
                {formError}
              </div>
            )}

            <div className="form-group">
              <label>Nom</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nom complet" />
            </div>

            <div className="form-group">
              <label>Email</label>
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
            </div>

            <div className="form-group">
              <label>{editUser ? 'Nouveau mot de passe (laisser vide pour garder)' : 'Mot de passe'}</label>
              <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
            </div>

            <div className="form-group">
              <label>Rôle</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="admin">Administrateur</option>
                <option value="manager">Manager</option>
                <option value="employee">Employé</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="button" onClick={() => setShowModal(false)}>Annuler</button>
              <button className="button button-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Enregistrement…' : editUser ? 'Modifier' : 'Créer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
