import 'express-async-errors';
import { Prisma } from '@prisma/client';
import cors from 'cors';
import express from 'express';
import { NextFunction, Request, Response } from 'express';
import { clientsRouter } from './modules/clients/routes';
import { filesRouter } from './modules/files/routes';
import { invoicesRouter } from './modules/invoices/routes';
import { productsRouter } from './modules/products/routes';
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { apiKeysRouter } from './modules/api-keys/routes';
import { monitoringRouter } from './modules/monitoring/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { tenantCheckRouter } from './modules/_tenant-check/routes';
import { prisma } from './prisma';

export const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'backend' });
});

app.get('/health/db', async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    return res.json({ status: 'ok', database: 'connected' });
  } catch {
    return res.status(503).json({
      status: 'degraded',
      database: 'unreachable',
      code: 'DATABASE_UNAVAILABLE'
    });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/products', productsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/files', filesRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/monitoring', monitoringRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/_tenant-check', tenantCheckRouter); // F6.2 verification — delete after F6.4

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API ERROR]', error);

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return res.status(503).json({
      message: 'Database is unavailable. Start MongoDB/Docker and retry.',
      code: 'DATABASE_UNAVAILABLE'
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return res.status(400).json({
      message: error.message,
      code: error.code
    });
  }

  const message = error instanceof Error ? error.message : 'Unexpected server error';
  return res.status(500).json({
    message,
    code: 'INTERNAL_SERVER_ERROR'
  });
});
