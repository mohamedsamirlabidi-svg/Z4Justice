/**
 * Notification queries (F5 uses this for the timeline).
 *
 *   GET /api/notifications?clientId=X    — recent notifications for a client
 *   GET /api/notifications?invoiceId=X   — notifications for a single invoice
 */
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../prisma';
import { authMiddleware } from '../auth/middleware';

export const notificationsRouter = Router();
notificationsRouter.use(authMiddleware);

notificationsRouter.get('/', async (req, res) => {
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const invoiceId = typeof req.query.invoiceId === 'string' ? req.query.invoiceId : undefined;
  const takeRaw = typeof req.query.take === 'string' ? Number(req.query.take) : 50;
  const take = Number.isFinite(takeRaw) && takeRaw > 0 ? Math.min(Math.floor(takeRaw), 200) : 50;

  const where: Prisma.NotificationLogWhereInput = {};
  if (clientId) where.clientId = clientId;
  if (invoiceId) where.invoiceId = invoiceId;

  const rows = await prisma.notificationLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
  });

  return res.json({ rows, take });
});
