/**
 * Tenant context (F6.2).
 *
 * AsyncLocalStorage-backed request/job scope for tenant isolation.
 * The Prisma client extension (src/prisma.ts) reads this store and
 * injects `tenantId` into every read/write on tenant-scoped models.
 *
 *   runWithTenant(tenantId, fn)  — the normal path (HTTP handlers, per-tenant jobs)
 *   runAsSystem(reason, fn)      — explicit escape hatch (auth hydration, migrations,
 *                                  platform admin, ingest before per-tenant API keys)
 *   getTenantContext()           — read the current context (may be undefined)
 *   requireTenantContext()       — read or throw (used inside the extension)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type TenantContext =
  | { kind: 'tenant'; tenantId: string; userId?: string }
  | { kind: 'system'; reason: string };

const store = new AsyncLocalStorage<TenantContext>();

export class TenantContextMissingError extends Error {
  constructor(model: string, operation: string) {
    super(
      `[tenant-guard] No tenant context set for ${model}.${operation}. ` +
        `Wrap the call in runWithTenant(tenantId, fn) or runAsSystem(reason, fn).`,
    );
    this.name = 'TenantContextMissingError';
  }
}

/**
 * IMPORTANT: `fn` is wrapped in an `async` callback and awaited INSIDE
 * store.run(). Prisma uses lazy PrismaPromises — the query only executes
 * when .then() is called. If we returned the PrismaPromise from store.run
 * synchronously, the ALS scope would close before Prisma's extension fires,
 * and the guard would see no tenant. Awaiting inside the scope keeps ALS
 * active until the query has been dispatched.
 */
export function runWithTenant<T>(
  tenantId: string,
  fn: () => T | Promise<T>,
  opts?: { userId?: string },
): Promise<T> {
  if (!tenantId) {
    throw new Error('[tenant-guard] runWithTenant called with empty tenantId');
  }
  return store.run({ kind: 'tenant', tenantId, userId: opts?.userId }, async () => await fn());
}

export function runAsSystem<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
  if (!reason) {
    throw new Error('[tenant-guard] runAsSystem requires a non-empty reason for auditability');
  }
  return store.run({ kind: 'system', reason }, async () => await fn());
}

export function getTenantContext(): TenantContext | undefined {
  return store.getStore();
}

export function requireTenantContext(model: string, operation: string): TenantContext {
  const ctx = store.getStore();
  if (!ctx) {
    throw new TenantContextMissingError(model, operation);
  }
  return ctx;
}

/**
 * Return the current tenant id, or throw. Used by handlers that must construct
 * compound unique keys (e.g. `{ tenantId_invoiceNo: { tenantId, invoiceNo } }`)
 * for Prisma operations where the extension's implicit injection can't reach
 * (currently: upsert `where` clause typing).
 *
 * Never callable from a `runAsSystem` scope — those callers must know their
 * target tenant explicitly.
 */
export function currentTenantId(): string {
  const ctx = store.getStore();
  if (!ctx) {
    throw new Error('[tenant-guard] currentTenantId() called outside any context');
  }
  if (ctx.kind !== 'tenant') {
    throw new Error(
      '[tenant-guard] currentTenantId() called inside runAsSystem — pass the tenantId explicitly',
    );
  }
  return ctx.tenantId;
}
