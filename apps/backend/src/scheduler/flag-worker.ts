/**
 * Flag worker (F1b).
 *
 * For each active tenant, computes the correct flag color for every invoice
 * via computeFlag(now, dueDate, paymentStatus) and updates rows where the
 * new flag differs from the stored value.
 *
 * We iterate + per-row-update rather than bulk updateMany because Prisma's
 * MongoDB filter `{ field: { not: X } }` does NOT match documents where the
 * field is missing (legacy invoices predate the flagStatus/paymentStatus
 * columns). Bulk updates would silently skip those rows.
 *
 * Cost: on the first pass ~2,500 per-row updates per tenant = ~2 min against
 * Atlas. Subsequent hourly runs skip idempotent no-ops, so they're much
 * cheaper.
 */
import { prisma } from '../prisma';
import { runAsSystem, runWithTenant } from '../tenant-context';
import { computeFlag, FlagColor } from './flag-rules';
import { dispatchForInvoiceFlag } from '../modules/notifications/engine';

type PerColor = Record<FlagColor, number>;
type BulkResult = {
  tenantId: string;
  scannedInvoices: number;
  updates: PerColor;
  totalUpdated: number;
  notified: number;
  durationMs: number;
};

function newCounters(): PerColor {
  return { green: 0, yellow: 0, orange: 0, red: 0, none: 0 };
}

/**
 * Run the flag worker for a single tenant. Returns per-color update counts.
 */
export async function runFlagWorkerForTenant(
  tenantId: string,
  now: Date = new Date(),
): Promise<BulkResult> {
  const started = Date.now();

  return runWithTenant(tenantId, async () => {
    const invoices = await prisma.invoice.findMany({
      select: {
        id: true,
        tenantId: true,
        invoiceNo: true,
        totalAmount: true,
        currency: true,
        dueDate: true,
        paymentStatus: true,
        flagStatus: true,
        companyName: true,
        client: {
          select: { id: true, name: true, phone: true, email: true },
        },
      },
    });

    const counters = newCounters();
    let totalUpdated = 0;
    let notified = 0;

    for (const inv of invoices) {
      const paymentStatus = inv.paymentStatus ?? 'not_declared';
      const currentFlag = (inv.flagStatus ?? 'none') as FlagColor;
      const newFlag = computeFlag(now, inv.dueDate, paymentStatus);

      if (newFlag === currentFlag) continue;

      await prisma.invoice.update({
        where: { id: inv.id },
        data: { flagStatus: newFlag, flagUpdatedAt: now },
      });
      counters[newFlag] += 1;
      totalUpdated += 1;

      // F2 wiring: fire notifications on transition into yellow/orange/red.
      // Engine dedups via NotificationLog so this is safe even if the worker
      // sees the same transition again after a restart.
      if (newFlag === 'yellow' || newFlag === 'orange' || newFlag === 'red') {
        try {
          const result = await dispatchForInvoiceFlag({
            invoice: {
              id: inv.id,
              tenantId: inv.tenantId,
              invoiceNo: inv.invoiceNo,
              totalAmount: inv.totalAmount,
              currency: inv.currency,
              dueDate: inv.dueDate,
              companyName: inv.companyName,
              client: inv.client,
            },
            flag: newFlag,
            now,
          });
          if (result.attempts.length > 0) notified += 1;
        } catch (err) {
          console.error(`[flag-worker] notification dispatch failed for invoice=${inv.id}:`, err);
        }
      }
    }

    return {
      tenantId,
      scannedInvoices: invoices.length,
      updates: counters,
      totalUpdated,
      notified,
      durationMs: Date.now() - started,
    };
  });
}

/**
 * Run the flag worker across every active tenant.
 */
export async function runFlagWorkerAllTenants(now: Date = new Date()): Promise<BulkResult[]> {
  const tenants = await runAsSystem('flag-worker:list-tenants', () =>
    prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, slug: true },
    }),
  );

  const results: BulkResult[] = [];
  for (const t of tenants) {
    try {
      const r = await runFlagWorkerForTenant(t.id, now);
      results.push(r);
      const u = r.updates;
      console.log(
        `[flag-worker] tenant=${t.slug} scanned=${r.scannedInvoices} updated=${r.totalUpdated} `
          + `(green+=${u.green} red+=${u.red} orange+=${u.orange} yellow+=${u.yellow} none+=${u.none}) `
          + `notified=${r.notified} duration=${r.durationMs}ms`,
      );
    } catch (err) {
      console.error(`[flag-worker] tenant=${t.slug} failed:`, err);
    }
  }
  return results;
}
