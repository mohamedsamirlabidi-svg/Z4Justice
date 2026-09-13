/**
 * TEMPORARY (F6.2): proves the tenant guard works end-to-end.
 * Delete this module once F6.4 lands and you've eyeballed the results.
 *
 *   GET /api/_tenant-check
 *     Requires JWT. Returns counts scoped to the caller's tenant, plus a
 *     comparison against system-wide counts, plus a probe attempting to read
 *     a fake other-tenant row (must return null).
 */
import { Router } from 'express';
import { prisma } from '../../prisma';
import { runAsSystem, runWithTenant, getTenantContext } from '../../tenant-context';
import { authMiddleware } from '../auth/middleware';

export const tenantCheckRouter = Router();

tenantCheckRouter.use(authMiddleware);

tenantCheckRouter.get('/', async (_req, res) => {
  const ctx = getTenantContext();

  // 1. Tenant-scoped counts (through the guard).
  const scopedClients = await prisma.client.count();
  const scopedInvoices = await prisma.invoice.count();
  const scopedFiles = await prisma.importedFile.count();

  // 2. System-wide counts (bypass the guard). Should be >= scoped counts.
  const systemClients = await runAsSystem('tenant-check-probe', () => prisma.client.count());
  const systemInvoices = await runAsSystem('tenant-check-probe', () => prisma.invoice.count());
  const systemFiles = await runAsSystem('tenant-check-probe', () =>
    prisma.importedFile.count(),
  );

  // 3. Cross-tenant probe (Policy A: silent override). Caller passes a fake
  // tenantId in `where`. Guard MUST replace it with the ambient tenantId so
  // no row from another tenant leaks. Correct behavior: every returned row
  // has tenantId === caller's ambient tenantId (NOT the fake one).
  const fakeTenantId = '000000000000000000000000';
  const crossTenantProbe = await prisma.client.findMany({
    where: { tenantId: fakeTenantId },
    take: 5,
    select: { id: true, name: true, tenantId: true },
  });

  // 4. runWithTenant probe: explicitly enter a fake tenant scope and count
  // clients. Should be 0 — fake tenant has no data.
  const fakeTenantCount = await runWithTenant(fakeTenantId, () => prisma.client.count());

  const ambientTenantId = ctx?.kind === 'tenant' ? ctx.tenantId : null;
  const allProbeRowsAreAmbient =
    ambientTenantId !== null &&
    crossTenantProbe.every((row) => row.tenantId === ambientTenantId);
  const noProbeRowIsFake = crossTenantProbe.every((row) => row.tenantId !== fakeTenantId);

  return res.json({
    context: ctx,
    scopedCounts: {
      clients: scopedClients,
      invoices: scopedInvoices,
      files: scopedFiles,
    },
    systemCounts: {
      clients: systemClients,
      invoices: systemInvoices,
      files: systemFiles,
    },
    crossTenantProbe: {
      description:
        'Attempted findMany with where: { tenantId: <fake> }. Guard overrides tenantId to ambient, so every returned row must have tenantId === ambient (never the fake id).',
      rowsReturned: crossTenantProbe.length,
      allRowsAreAmbient: allProbeRowsAreAmbient,
      noRowIsFake: noProbeRowIsFake,
      sampleRows: crossTenantProbe,
    },
    fakeTenantCount: {
      description:
        'runWithTenant(<fake>, () => prisma.client.count()). Should be 0 (fake tenant has no data).',
      value: fakeTenantCount,
    },
    ok:
      allProbeRowsAreAmbient &&
      noProbeRowIsFake &&
      fakeTenantCount === 0 &&
      scopedClients <= systemClients &&
      scopedInvoices <= systemInvoices &&
      scopedFiles <= systemFiles,
  });
});
