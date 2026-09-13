/**
 * Tenant-guarded Prisma client (F6.2).
 *
 * Every read/write on a tenant-scoped model MUST run inside a tenant context
 * (see src/tenant-context.ts). The extension:
 *   - throws TenantContextMissingError if no context is set,
 *   - injects `tenantId` into `where` for reads/updates/deletes/aggregates,
 *   - injects `tenantId` into `data` for creates/upserts,
 *   - transparently rewrites `findUnique`/`upsert` calls that use pre-migration
 *     unique keys (invoiceNo, fullPath, email) to their compound-key equivalents,
 *   - is a NO-OP for calls made inside runAsSystem() (used by auth hydration,
 *     migrations, ingest before per-tenant API keys land in F6.4).
 *
 * The BASE client is exported ONLY for narrow internal uses that must bypass
 * the guard (auth hydration, the extension itself). Application code MUST NOT
 * import it — use `prisma` and, if needed, wrap calls in runAsSystem().
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { getTenantContext, TenantContextMissingError } from './tenant-context';

// Prisma sends model names in PascalCase to $allOperations. Match against this set.
const TENANT_SCOPED_MODELS = new Set([
  'Client',
  'Product',
  'Invoice',
  'InvoiceItem',
  'ImportedFile',
  'User',
  'TenantApiKey',
  'NotificationLog',
]);

// Where-injection ops (tenantId goes into args.where)
const WHERE_INJECT_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

// Create ops (tenantId goes into args.data)
const CREATE_OPS = new Set(['create', 'createMany']);

// Map old single-column unique keys (removed in F6.1b) to the compound key name Prisma generates.
// Used to transparently rewrite legacy findUnique/upsert calls.
const OLD_UNIQUE_TO_COMPOUND: Record<string, Array<{ field: string; compound: string }>> = {
  Invoice: [{ field: 'invoiceNo', compound: 'tenantId_invoiceNo' }],
  ImportedFile: [{ field: 'fullPath', compound: 'tenantId_fullPath' }],
  User: [{ field: 'email', compound: 'tenantId_email' }],
};

function findLegacyUniqueField(
  model: string,
  where: Record<string, unknown> | undefined,
): { field: string; compound: string } | null {
  if (!where) return null;
  const mappings = OLD_UNIQUE_TO_COMPOUND[model];
  if (!mappings) return null;
  for (const m of mappings) {
    if (m.field in where && !(m.compound in where)) {
      return m;
    }
  }
  return null;
}

function modelKeyOf(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Convert a WhereUniqueInput that uses a compound key (e.g.
 * `{ tenantId_invoiceNo: { tenantId, invoiceNo } }`) into a flat WhereInput
 * (`{ invoiceNo }`). The tenantId from the compound key is intentionally
 * dropped — the extension re-injects the ambient tenant context afterwards.
 */
function flattenCompoundKeys(
  where: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!where) return out;
  for (const [key, value] of Object.entries(where)) {
    if (key.startsWith('tenantId_') && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subKey !== 'tenantId') {
          out[subKey] = subValue;
        }
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

function injectWhere(args: Record<string, unknown> | undefined, tenantId: string) {
  const next = { ...(args ?? {}) } as Record<string, unknown>;
  const where = (next.where as Record<string, unknown> | undefined) ?? {};
  // Always override — a handler cannot escape tenant scope by passing tenantId
  // itself. Platform admins wanting cross-tenant queries must use runAsSystem().
  next.where = { ...where, tenantId };
  return next;
}

function injectData(args: Record<string, unknown> | undefined, tenantId: string) {
  const next = { ...(args ?? {}) } as Record<string, unknown>;
  const data = next.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  // Always override tenantId — a caller cannot escape by passing another value.
  if (Array.isArray(data)) {
    next.data = data.map((row) => ({ ...row, tenantId }));
  } else {
    next.data = { ...(data ?? {}), tenantId };
  }
  return next;
}

/**
 * The base (unguarded) client. Kept module-private except for the narrow
 * export below — do NOT import this from application code.
 */
const basePrisma = new PrismaClient();

export const prisma = basePrisma.$extends({
  name: 'tenant-guard',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const ctx = getTenantContext();
        if (!ctx) {
          throw new TenantContextMissingError(model, operation);
        }

        // System context: no injection or rewrite. Caller is responsible.
        if (ctx.kind === 'system') {
          return query(args);
        }

        const tenantId = ctx.tenantId;
        const rawArgs = (args ?? {}) as Record<string, unknown>;

        // ── findUnique rewrite (always) ──
        // findUnique with a raw id would return rows across tenants. Route every
        // findUnique on tenant-scoped models through findFirst so tenantId is
        // enforced as an AND filter.
        if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
          const flatWhere = flattenCompoundKeys(rawArgs.where as Record<string, unknown> | undefined);
          const injected = injectWhere({ ...rawArgs, where: flatWhere }, tenantId);
          const method = operation === 'findUniqueOrThrow' ? 'findFirstOrThrow' : 'findFirst';
          // Bypass extension recursion — tenantId is already in injected.where.
          const modelClient = (basePrisma as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[
            modelKeyOf(model)
          ];
          return modelClient[method](injected);
        }

        // ── Legacy upsert rewrite ──
        if (operation === 'upsert') {
          const legacy = findLegacyUniqueField(model, rawArgs.where as Record<string, unknown>);
          const next = { ...rawArgs };
          if (legacy) {
            const where = { ...(rawArgs.where as Record<string, unknown>) };
            const legacyValue = where[legacy.field];
            delete where[legacy.field];
            where[legacy.compound] = { tenantId, [legacy.field]: legacyValue };
            next.where = where;
          }
          // Ensure `create` carries tenantId.
          const create = (next.create as Record<string, unknown> | undefined) ?? {};
          next.create = { tenantId, ...create };
          return query(next as unknown as typeof args);
        }

        if (WHERE_INJECT_OPS.has(operation)) {
          // Defense in depth: for wide-scope destructive ops, still refuse if
          // the caller passed truly-empty args. The extension will inject
          // tenantId, so the delete/update is technically scoped — but the
          // history of dev bugs where the wrong client was used shows we
          // want a loud failure signal on the guarded client too. Callers
          // that legitimately want "delete/update everything in my tenant"
          // must be explicit: `deleteMany({ where: { tenantId: currentTenantId() } })`.
          if ((operation === 'deleteMany' || operation === 'updateMany')
              && (!rawArgs || Object.keys(rawArgs).length === 0)) {
            throw new Error(
              `[tenant-guard] ${model}.${operation}() called with no arguments at all — refuse. `
                + `If you really mean "everything in the current tenant", pass an explicit `
                + `{ where: { tenantId: currentTenantId() } } to make the intent visible.`,
            );
          }
          return query(injectWhere(rawArgs, tenantId) as unknown as typeof args);
        }

        if (CREATE_OPS.has(operation)) {
          return query(injectData(rawArgs, tenantId) as unknown as typeof args);
        }

        // Unknown operation — let it through unchanged rather than fail closed and
        // break something we didn't anticipate. If Prisma adds a new op, we'll notice.
        return query(args);
      },
    },
  },
});

export { Prisma };
