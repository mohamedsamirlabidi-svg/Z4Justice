import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import { prisma } from '../../prisma';
import { migrateAllFilesFromFolders, processImportedFile, processQueuedFiles, rescanProcessedFiles } from './ingestion/service';
import { computeFlag } from '../../scheduler/flag-rules';
import { cacheClear, cacheDeleteByPrefix, cacheGetOrSet } from '../../cache';
import { currentTenantId, runAsSystem, runWithTenant } from '../../tenant-context';
import { authMiddleware } from '../auth/middleware';
import { extractApiKeyFromHeaders, hashApiKey } from '../api-keys/service';

export const filesRouter = Router();

// Upload storage — save to a temp dir, keep the file so sourceFile references stay valid.
const UPLOAD_DIR = path.join(os.tmpdir(), 'mini-erm-uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* exists */ }
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// F6.2: every route requires an authenticated tenant user EXCEPT /ingest, which
// authenticates via a static INGEST_API_KEY (F6.4 replaces this with per-tenant keys).
filesRouter.use((req, res, next) => {
  if (req.path === '/ingest') return next();
  return authMiddleware(req, res, next);
});

/**
 * Ingest tenant resolution (F6.4).
 *
 * Preferred path: caller sends `Authorization: Bearer <api-key>` or
 * `x-api-key: <api-key>` header. We hash the key, look it up in TenantApiKey,
 * verify it's not revoked, and use its tenantId. `lastUsedAt` is updated
 * asynchronously (fire-and-forget) so the response isn't blocked.
 *
 * Legacy fallback: caller sends `x-ingest-key: <INGEST_API_KEY>` matching the
 * env value → we fall back to the default "Acrobate Solution" tenant. This
 * keeps the existing single-tenant watcher working during F7 rollout. Once
 * every deployed watcher/agent uses per-tenant keys, we can remove this.
 */

type IngestAuthResult =
  | { ok: true; tenantId: string; via: 'apiKey' | 'legacyStaticKey'; apiKeyId?: string }
  | { ok: false; status: number; message: string };

let cachedLegacyTenantId: string | undefined;
async function resolveLegacyIngestTenantId(): Promise<string> {
  if (cachedLegacyTenantId) return cachedLegacyTenantId;
  const tenant = await prisma.tenant.findFirst({ where: { slug: 'acrobate-solution' } });
  if (!tenant) {
    throw new Error(
      'Default ingest tenant "acrobate-solution" not found. Run the F6.3 backfill first.',
    );
  }
  cachedLegacyTenantId = tenant.id;
  return cachedLegacyTenantId;
}

async function authenticateIngest(req: Request): Promise<IngestAuthResult> {
  // 1) Preferred: per-tenant API key
  const plainKey = extractApiKeyFromHeaders({
    authorization: req.headers.authorization,
    'x-api-key': req.headers['x-api-key'] as string | undefined,
  });

  if (plainKey) {
    const keyHash = hashApiKey(plainKey);
    // Cross-tenant lookup — must bypass the guard.
    const record = await runAsSystem('ingest-authenticate', () =>
      prisma.tenantApiKey.findFirst({
        where: { keyHash },
        include: { tenant: { select: { id: true, isActive: true } } },
      }),
    );
    if (!record) return { ok: false, status: 401, message: 'Invalid API key.' };
    if (record.revokedAt) return { ok: false, status: 401, message: 'API key has been revoked.' };
    if (!record.tenant.isActive) return { ok: false, status: 403, message: 'Tenant is inactive.' };

    // Fire-and-forget last-used stamp.
    void runAsSystem('ingest-touch-key', () =>
      prisma.tenantApiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      }),
    ).catch(() => undefined);

    return { ok: true, tenantId: record.tenantId, via: 'apiKey', apiKeyId: record.id };
  }

  // 2) Legacy: static INGEST_API_KEY
  const legacy = process.env.INGEST_API_KEY;
  const provided = req.headers['x-ingest-key'];
  if (legacy && typeof provided === 'string' && provided === legacy) {
    const tenantId = await resolveLegacyIngestTenantId();
    return { ok: true, tenantId, via: 'legacyStaticKey' };
  }

  return { ok: false, status: 401, message: 'Unauthorized: provide x-api-key or x-ingest-key.' };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPrismaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';

  return (
    code === 'P2028' ||
    code === 'P2034' ||
    /transaction\s+with\s+\{\s*txnNumber\s*:\s*\d+\s*\}\s+has\s+been\s+aborted/i.test(message) ||
    /write\s+conflict|deadlock/i.test(message)
  );
}

async function upsertImportedFileWithRetry(fullPath: string, filename: string, extension: string) {
  const maxAttempts = Number(process.env.INGEST_UPSERT_MAX_ATTEMPTS ?? 5);
  const tenantId = currentTenantId();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.importedFile.upsert({
        where: { tenantId_fullPath: { tenantId, fullPath } },
        update: { status: 'queued', notes: 'Detected again / updated' },
        create: {
          filename,
          fullPath,
          extension,
          status: 'queued',
          notes: 'Queued for parser pipeline',
          tenantId
        }
      });
    } catch (error) {
      lastError = error;
      if (!isTransientPrismaError(error) || attempt >= maxAttempts) {
        throw error;
      }

      await sleep(50 * attempt);
    }
  }

  throw lastError;
}

filesRouter.get('/', async (_req: Request, res: Response) => {
  const req = _req;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
  const limit = limitRaw && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : undefined;

  const cacheKey = `files:list:${status || 'all'}:${limit || 'all'}`;
  const payload = await cacheGetOrSet(cacheKey, 30_000, async () => {
    const files = await prisma.importedFile.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ processedAt: 'desc' }, { detectedAt: 'desc' }],
      ...(limit ? { take: limit } : {})
    });

    const fullPaths = files.map((f) => f.fullPath);

    // Only fetch invoices whose sourceFile matches one of our file paths
    const matchedInvoices = fullPaths.length
      ? await prisma.invoice.findMany({
          where: { sourceFile: { in: fullPaths } },
          select: { id: true, invoiceNo: true, status: true, sourceFile: true, verified: true, documentType: true }
        })
      : [];

    // Build a fast lookup map: sourceFile -> invoice
    const invoiceByPath = new Map<string, typeof matchedInvoices[0]>();
    for (const inv of matchedInvoices) {
      if (!inv.sourceFile) continue;
      // Handle pipe-separated sourceFile values
      for (const s of inv.sourceFile.split('|')) {
        invoiceByPath.set(s.trim(), inv);
      }
    }

    return files.map((file) => {
      const inv = invoiceByPath.get(file.fullPath);
      return {
        ...file,
        invoiceLinked: inv
          ? {
              id: inv.id,
              invoiceNo: inv.invoiceNo,
              status: inv.status,
              verified: inv.verified,
              documentType: inv.documentType
            }
          : null
      };
    });
  });

  res.json(payload);
});

filesRouter.get('/failed', async (_req: Request, res: Response) => {
  const req = _req;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;

  const [total, rows] = await Promise.all([
    prisma.importedFile.count({ where: { status: 'failed' } }),
    prisma.importedFile.findMany({
      where: { status: 'failed' },
      orderBy: [{ processedAt: 'desc' }, { detectedAt: 'desc' }],
      take: limit,
      select: {
        id: true,
        filename: true,
        fullPath: true,
        extension: true,
        status: true,
        detectedAt: true,
        processedAt: true,
        notes: true
      }
    })
  ]);

  const fullPaths = rows.map((r) => r.fullPath);

  // Only fetch invoices whose sourceFile matches one of our file paths
  const matchedInvoices = fullPaths.length
    ? await prisma.invoice.findMany({
        where: { sourceFile: { in: fullPaths } },
        select: { id: true, invoiceNo: true, status: true, sourceFile: true, verified: true, documentType: true }
      })
    : [];

  const invoiceByPath = new Map<string, typeof matchedInvoices[0]>();
  for (const inv of matchedInvoices) {
    if (!inv.sourceFile) continue;
    for (const s of inv.sourceFile.split('|')) {
      invoiceByPath.set(s.trim(), inv);
    }
  }

  return res.json({
    total,
    rows: rows.map((row) => {
      const inv = invoiceByPath.get(row.fullPath);
      return {
        ...row,
        invoiceLinked: inv
          ? {
              id: inv.id,
              invoiceNo: inv.invoiceNo,
              status: inv.status,
              verified: inv.verified,
              documentType: inv.documentType
            }
          : null
      };
    })
  });
});

filesRouter.get('/stats', async (_req: Request, res: Response) => {
  const grouped = await prisma.importedFile.groupBy({
    by: ['status'],
    _count: { _all: true }
  });

  const stats = grouped.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = row._count._all;
    return acc;
  }, {});

  const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
  return res.json({ total, stats });
});

filesRouter.post('/ingest', async (req: Request, res: Response) => {
  const auth = await authenticateIngest(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ message: auth.message });
  }

  const { fullPath } = req.body;
  if (!fullPath) {
    return res.status(400).json({ message: 'fullPath is required' });
  }

  const filename = path.basename(fullPath);
  const extension = path.extname(filename).toLowerCase();

  return runWithTenant(auth.tenantId, async () => {
    const saved = await upsertImportedFileWithRetry(fullPath, filename, extension);
    cacheClear();

    const shouldProcessNow = req.query.processNow === 'true';
    if (shouldProcessNow) {
      try {
        await processImportedFile(saved.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Immediate processing failed';
        return res.status(202).json({
          ...saved,
          message,
          authVia: auth.via
        });
      }
    }

    return res.status(201).json({ ...saved, authVia: auth.via });
  });
});

/**
 * POST /api/files/upload — F4 manual upload (authenticated user).
 * Accepts multipart form-data with field name "file". Runs the same
 * extraction pipeline as the folder watcher, immediately processes,
 * computes the flag, and returns the created invoice.
 */
filesRouter.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    return res.status(400).json({ message: 'No file provided (field name: "file")' });
  }

  const tenantId = currentTenantId();
  const filename = file.originalname;
  const extension = path.extname(filename).toLowerCase();

  if (!['.pdf', '.xls', '.xlsx', '.csv'].includes(extension)) {
    // Clean up unsupported file
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    return res.status(400).json({ message: `Unsupported file type: ${extension || '(none)'}. Allowed: .pdf, .xls, .xlsx, .csv` });
  }

  try {
    const imported = await prisma.importedFile.create({
      data: {
        filename,
        fullPath: file.path,
        extension,
        status: 'queued',
        notes: 'Uploaded via manual upload UI',
        tenantId,
      },
    });

    const invoice = await processImportedFile(imported.id);

    // Compute + set flag immediately so it appears in monitoring without waiting for cron.
    if (invoice) {
      const freshFlag = computeFlag(new Date(), invoice.dueDate ?? null, invoice.paymentStatus ?? 'not_declared');
      if (freshFlag !== invoice.flagStatus) {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { flagStatus: freshFlag, flagUpdatedAt: new Date() },
        });
      }
    }

    // Reload invoice with client info for the client-side preview.
    const preview = invoice
      ? await prisma.invoice.findFirst({
          where: { id: invoice.id },
          include: {
            client: { select: { id: true, name: true } },
            items: { select: { id: true, quantity: true, unitPrice: true, lineTotal: true, description: true } },
          },
        })
      : null;

    cacheClear();
    return res.status(201).json({
      ok: true,
      importedFile: { id: imported.id, filename, fullPath: file.path },
      invoice: preview,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload processing failed';
    return res.status(500).json({ ok: false, message });
  }
});

filesRouter.post('/process-queued', async (req: Request, res: Response) => {
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;
  const drain = typeof req.query.drain === 'string' ? req.query.drain !== 'false' : true;
  const maxBatchesRaw = typeof req.query.maxBatches === 'string' ? Number(req.query.maxBatches) : 200;
  const maxBatches = Number.isFinite(maxBatchesRaw) && maxBatchesRaw > 0 ? Math.floor(maxBatchesRaw) : 200;

  const result = await processQueuedFiles(limit, { drain, maxBatches });
  cacheClear();
  return res.json(result);
});

filesRouter.post('/rescan-processed', async (req: Request, res: Response) => {
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : 200;
  const concurrencyRaw = typeof req.query.concurrency === 'string' ? Number(req.query.concurrency) : undefined;
  const concurrency = Number.isFinite(concurrencyRaw) && (concurrencyRaw ?? 0) > 0
    ? Math.min(Math.floor(concurrencyRaw!), 16)
    : undefined;
  const skipVerified = typeof req.query.skipVerified === 'string' ? req.query.skipVerified !== 'false' : true;
  const useAi = typeof req.query.useAi === 'string' ? req.query.useAi !== 'false' : true;
  const updateInvoice = typeof req.query.updateInvoice === 'string' ? req.query.updateInvoice !== 'false' : true;
  const excludeIds = Array.isArray(req.body?.excludeIds)
    ? req.body.excludeIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  const result = await rescanProcessedFiles(limit, {
    concurrency,
    useAi,
    updateInvoice,
    skipVerified,
    excludeImportedFileIds: excludeIds
  });
  cacheClear();
  return res.json(result);
});

filesRouter.post('/retry-failed', async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];

  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

  const targets = ids.length
    ? await prisma.importedFile.findMany({
        where: {
          id: { in: ids },
          status: 'failed'
        },
        orderBy: { detectedAt: 'asc' }
      })
    : await prisma.importedFile.findMany({
        where: { status: 'failed' },
        orderBy: { detectedAt: 'asc' },
        take: limit
      });

  if (targets.length === 0) {
    return res.json({ total: 0, retried: 0, succeeded: 0, failed: 0, results: [] });
  }

  await prisma.importedFile.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: {
      status: 'queued',
      notes: 'Retry requested'
    }
  });

  const queue = [...targets.map((t) => t.id)];
  const concurrency = Number(process.env.INGEST_RETRY_CONCURRENCY ?? 4);
  const results: Array<{ id: string; ok: boolean; message?: string }> = [];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;

      try {
        await processImportedFile(id);
        results.push({ id, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown retry error';
        results.push({ id, ok: false, message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  cacheClear();

  return res.json({
    total: targets.length,
    retried: targets.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  });
});

filesRouter.post('/migrate-all', async (req: Request, res: Response) => {
  const envFolders = (process.env.WATCH_FOLDERS ?? process.env.WATCH_FOLDER ?? '')
    .split(';')
    .map((folder) => folder.trim())
    .filter(Boolean);

  const bodyFolders = Array.isArray(req.body?.folders)
    ? req.body.folders.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  const folders = bodyFolders.length > 0 ? bodyFolders : envFolders;
  if (folders.length === 0) {
    return res.status(400).json({ message: 'No folders provided. Configure WATCH_FOLDERS or send body.folders.' });
  }

  const processNow = req.query.processNow === 'true' || req.body?.processNow === true;
  const includeProcessed = req.query.includeProcessed === 'true' || req.body?.includeProcessed === true;

  const result = await migrateAllFilesFromFolders(folders, { processNow, includeProcessed });
  cacheClear();
  return res.json(result);
});

filesRouter.post('/:id/process', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!id) {
    return res.status(400).json({ ok: false, message: 'Missing imported file id' });
  }

  try {
    const invoice = await processImportedFile(id);
    cacheClear();
    return res.json({ ok: true, invoice });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Processing failed';
    return res.status(400).json({ ok: false, message });
  }
});

filesRouter.delete('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!id) {
    return res.status(400).json({ message: 'Missing imported file id' });
  }

  await prisma.importedFile.delete({ where: { id } });
  cacheClear();
  return res.status(204).send();
});
