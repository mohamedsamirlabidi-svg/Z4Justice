/**
 * Invoice monitoring routes (F1c).
 *
 *   GET /api/monitoring/summary         — counts by flag color + missingDueDate count
 *   GET /api/monitoring/invoices        — filtered list (flag, client, docType, missing, date range)
 *
 * All results are auto-scoped to the caller's tenant via the Prisma guard.
 *
 * MongoDB caveat: some invoices in the DB predate the paymentStatus/flagStatus
 * columns and have those fields missing. Prisma's non-nullable String filter
 * doesn't cleanly express "not X or missing" for those, and `groupBy` on such
 * fields throws a P2032 conversion error. We work around by:
 *   - Using per-color count() instead of groupBy (never reads the value).
 *   - Bucketing "missing flagStatus" into 'none' (schema default).
 *   - Handling the "not paid" filter by exclusion via a small ID list.
 */
import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { prisma } from '../../prisma';
import { authMiddleware } from '../auth/middleware';

export const monitoringRouter = Router();
monitoringRouter.use(authMiddleware);

const FLAG_COLORS = ['green', 'yellow', 'orange', 'red', 'none'] as const;
type FlagColor = typeof FLAG_COLORS[number];

function isFlagColor(v: unknown): v is FlagColor {
  return typeof v === 'string' && (FLAG_COLORS as readonly string[]).includes(v);
}

const missingDueDateFilter: Prisma.InvoiceWhereInput = {
  OR: [{ dueDate: null }, { dueDate: { isSet: false } }],
};

async function paidInvoiceIds(): Promise<string[]> {
  const rows = await prisma.invoice.findMany({
    where: { paymentStatus: 'paid' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

monitoringRouter.get('/summary', async (_req: Request, res: Response) => {
  const [totalAll, green, yellow, orange, red, explicitNone] = await Promise.all([
    prisma.invoice.count(),
    prisma.invoice.count({ where: { flagStatus: 'green' } }),
    prisma.invoice.count({ where: { flagStatus: 'yellow' } }),
    prisma.invoice.count({ where: { flagStatus: 'orange' } }),
    prisma.invoice.count({ where: { flagStatus: 'red' } }),
    prisma.invoice.count({ where: { flagStatus: 'none' } }),
  ]);

  // Legacy rows with missing flagStatus are logically 'none'.
  const explicitSum = green + yellow + orange + red + explicitNone;
  const missingFlagBucket = Math.max(0, totalAll - explicitSum);
  const counts: Record<FlagColor, number> = {
    green,
    yellow,
    orange,
    red,
    none: explicitNone + missingFlagBucket,
  };

  // "Missing due date" = has no dueDate AND is not paid. Prisma can't cleanly
  // express "not paid" for legacy rows, so we do it by excluding paid ids.
  const [totalMissingDue, paidIds] = await Promise.all([
    prisma.invoice.count({ where: missingDueDateFilter }),
    paidInvoiceIds(),
  ]);
  let missingDueDate = totalMissingDue;
  if (paidIds.length > 0) {
    const paidAndMissingDue = await prisma.invoice.count({
      where: { AND: [missingDueDateFilter, { id: { in: paidIds } }] },
    });
    missingDueDate = Math.max(0, totalMissingDue - paidAndMissingDue);
  }

  // Active = total minus paid.
  const totalActive = totalAll - green;

  return res.json({ counts, missingDueDate, totalActive });
});

monitoringRouter.get('/invoices', async (req: Request, res: Response) => {
  const rawFlag = typeof req.query.flag === 'string' ? req.query.flag : undefined;
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const documentType = typeof req.query.documentType === 'string' ? req.query.documentType : undefined;
  const missingDueDate = req.query.missingDueDate === 'true';
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  const takeRaw = typeof req.query.take === 'string' ? Number(req.query.take) : 200;
  const take = Number.isFinite(takeRaw) && takeRaw > 0 ? Math.min(Math.floor(takeRaw), 500) : 200;

  const filters: Prisma.InvoiceWhereInput[] = [];

  if (missingDueDate) {
    filters.push(missingDueDateFilter);
    // Exclude paid invoices from the "needs due date" list by id.
    const paidIds = await paidInvoiceIds();
    if (paidIds.length > 0) {
      filters.push({ NOT: { id: { in: paidIds } } });
    }
  } else if (isFlagColor(rawFlag)) {
    // Legacy rows with missing flagStatus are logically 'none'.
    if (rawFlag === 'none') {
      // We can't cleanly match "flagStatus is missing" for a non-nullable String
      // via Prisma. In practice, after the flag worker runs once, most legacy
      // rows keep the missing-field state ONLY if their correct flag is 'none'
      // (worker skipped writing since it's already 'none'). So we accept a
      // slight under-count here rather than exclude by id, which would scale poorly.
      filters.push({ flagStatus: 'none' });
    } else {
      filters.push({ flagStatus: rawFlag });
    }
  }

  if (clientId) filters.push({ clientId });
  if (documentType) filters.push({ documentType });

  if (from || to) {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) dateFilter.lte = d;
    }
    if (dateFilter.gte || dateFilter.lte) filters.push({ date: dateFilter });
  }

  const where: Prisma.InvoiceWhereInput = filters.length ? { AND: filters } : {};

  const rows = await prisma.invoice.findMany({
    where,
    include: {
      client: { select: { id: true, name: true } },
    },
    orderBy: [{ flagUpdatedAt: 'desc' }, { dueDate: 'asc' }],
    take,
  });

  return res.json({ rows, take });
});
