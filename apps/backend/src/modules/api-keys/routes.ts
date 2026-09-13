/**
 * Per-tenant API key management (F6.4).
 *
 * All routes require an authenticated tenant admin user.
 *   GET    /api/api-keys             — list (metadata only, no plaintext)
 *   POST   /api/api-keys             — mint (returns plaintext ONCE)
 *   POST   /api/api-keys/:id/revoke  — revoke (sets revokedAt; row kept for audit)
 *   DELETE /api/api-keys/:id         — hard delete (audit trail lost)
 */
import { Router } from 'express';
import { prisma } from '../../prisma';
import { currentTenantId } from '../../tenant-context';
import { authMiddleware, requireRole } from '../auth/middleware';
import { hashApiKey, mintApiKeyPlain, prefixFor } from './service';

export const apiKeysRouter = Router();

apiKeysRouter.use(authMiddleware, requireRole('admin'));

// GET /api/api-keys — list keys for the current tenant (metadata only)
apiKeysRouter.get('/', async (_req, res) => {
  const keys = await prisma.tenantApiKey.findMany({
    orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdBy: true,
    },
  });
  return res.json(keys);
});

// POST /api/api-keys — mint a new key. Plaintext is returned ONCE.
apiKeysRouter.post('/', async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: 'A name (label) is required for the API key.' });
  }

  const plain = mintApiKeyPlain();
  const keyHash = hashApiKey(plain);
  const keyPrefix = prefixFor(plain);

  const created = await prisma.tenantApiKey.create({
    data: {
      name: name.trim(),
      keyPrefix,
      keyHash,
      tenantId: currentTenantId(),
      createdBy: req.user!.userId,
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
    },
  });

  return res.status(201).json({
    ...created,
    key: plain,
    warning:
      'This plaintext key is shown only once. Copy it now — you will not be able to retrieve it again.',
  });
});

// POST /api/api-keys/:id/revoke — set revokedAt without deleting the row.
// Two-step (find, then update) avoids Prisma's MongoDB quirk where
// `where: { revokedAt: null }` doesn't match documents with a missing field.
apiKeysRouter.post('/:id/revoke', async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.tenantApiKey.findFirst({
    where: { id },
    select: { id: true, revokedAt: true },
  });
  if (!existing) {
    return res.status(404).json({ message: 'API key not found.' });
  }
  if (existing.revokedAt) {
    return res.json({ ok: true, alreadyRevoked: true, revokedAt: existing.revokedAt });
  }
  const now = new Date();
  await prisma.tenantApiKey.updateMany({
    where: { id },
    data: { revokedAt: now },
  });
  return res.json({ ok: true, revokedAt: now });
});

// DELETE /api/api-keys/:id — hard delete
apiKeysRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const deleted = await prisma.tenantApiKey.deleteMany({ where: { id } });
  if (deleted.count === 0) {
    return res.status(404).json({ message: 'API key not found.' });
  }
  return res.status(204).send();
});
