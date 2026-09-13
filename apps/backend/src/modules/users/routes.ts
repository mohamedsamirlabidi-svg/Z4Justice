import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../prisma';
import { authMiddleware, requireRole } from '../auth/middleware';

export const usersRouter = Router();

// All user routes require admin
usersRouter.use(authMiddleware, requireRole('admin'));

// GET /api/users
usersRouter.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(users);
});

// POST /api/users
usersRouter.post('/', async (req, res) => {
  const { email, name, password, role } = req.body;
  if (!email || !name || !password) {
    return res.status(400).json({ message: 'Email, nom et mot de passe requis' });
  }
  const validRoles = ['admin', 'manager', 'employee'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ message: 'Rôle invalide' });
  }

  // findFirst — email is no longer globally unique (F6.1b). Extension injects
  // tenantId, so this only surfaces users within the current tenant.
  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    return res.status(409).json({ message: 'Cet email est déjà utilisé' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, name, passwordHash, role: role || 'employee' },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  return res.status(201).json(user);
});

// PUT /api/users/:id
usersRouter.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { email, name, password, role } = req.body;

  const validRoles = ['admin', 'manager', 'employee'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ message: 'Rôle invalide' });
  }

  const data: Record<string, unknown> = {};
  if (email) data.email = email;
  if (name) data.name = name;
  if (role) data.role = role;
  if (password) data.passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  return res.json(user);
});

// DELETE /api/users/:id
usersRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  // Prevent self-deletion
  if (req.user?.userId === id) {
    return res.status(400).json({ message: 'Impossible de supprimer votre propre compte' });
  }
  await prisma.user.delete({ where: { id } });
  return res.status(204).send();
});
