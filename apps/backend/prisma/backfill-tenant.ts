/**
 * Tenant backfill script (F6.3).
 *
 * Ensures a default Tenant row exists and sets tenantId on every row
 * of every tenant-scoped collection whose tenantId field is missing.
 *
 * NOTE: Uses raw MongoDB commands via prisma.$runCommandRaw because
 * Prisma's `where: { tenantId: null }` does not match missing-field
 * documents when the field is typed `@db.ObjectId` on MongoDB.
 *
 * Usage:
 *   npx tsx prisma/backfill-tenant.ts --dry-run   # counts only, no writes
 *   npx tsx prisma/backfill-tenant.ts             # live run
 *
 * Exits non-zero if any row still has a missing tenantId after the live run.
 */

import { Prisma, PrismaClient } from '@prisma/client';

const DEFAULT_TENANT_NAME = 'Acrobate Solution';
const DEFAULT_TENANT_SLUG = 'acrobate-solution';

// Collection names match Prisma model names (no @@map in schema).
const TENANT_SCOPED_COLLECTIONS = [
  'Client',
  'Product',
  'Invoice',
  'InvoiceItem',
  'ImportedFile',
  'User',
] as const;

type Collection = typeof TENANT_SCOPED_COLLECTIONS[number];

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const mode = dryRun ? 'DRY RUN' : 'LIVE';
  console.log(`\n=== Tenant backfill (${mode}) ===`);
  console.log(`Default tenant: name="${DEFAULT_TENANT_NAME}" slug="${DEFAULT_TENANT_SLUG}"\n`);

  const before = await snapshotCounts();
  console.log('Row counts BEFORE:');
  logSnapshot(before);

  const totalPending = sumMissing(before);
  if (totalPending === 0) {
    console.log('\nNothing to backfill — every row already has tenantId.');
    await prisma.$disconnect();
    return;
  }

  const existingTenant = await prisma.tenant.findFirst({
    where: {
      OR: [{ slug: DEFAULT_TENANT_SLUG }, { name: DEFAULT_TENANT_NAME }],
    },
  });

  let tenantId: string;
  if (existingTenant) {
    console.log(
      `\nReusing existing tenant: name="${existingTenant.name}" slug="${existingTenant.slug}" id=${existingTenant.id}`,
    );
    tenantId = existingTenant.id;
  } else if (dryRun) {
    console.log(
      `\n[DRY RUN] No matching tenant exists. Would CREATE: name="${DEFAULT_TENANT_NAME}" slug="${DEFAULT_TENANT_SLUG}" plan="pro"`,
    );
    tenantId = '<would-create-live>';
  } else {
    const created = await prisma.tenant.create({
      data: {
        name: DEFAULT_TENANT_NAME,
        slug: DEFAULT_TENANT_SLUG,
        plan: 'pro',
        isActive: true,
      },
    });
    console.log(
      `\nCreated tenant: name="${created.name}" slug="${created.slug}" id=${created.id}`,
    );
    tenantId = created.id;
  }

  if (dryRun) {
    console.log(
      `\n[DRY RUN] Would backfill ${totalPending} rows across ${
        TENANT_SCOPED_COLLECTIONS.length
      } collections. Re-run WITHOUT --dry-run to apply.`,
    );
    await prisma.$disconnect();
    return;
  }

  console.log(`\nApplying backfill with tenantId=${tenantId}...`);
  const results: Record<string, number> = {};
  for (const col of TENANT_SCOPED_COLLECTIONS) {
    const updated = await rawUpdateMissingTenantId(col, tenantId);
    results[col] = updated;
    console.log(`  ${col.padEnd(14)} updated: ${updated}`);
  }

  console.log('\nVerifying (missing must be 0 for all)...');
  const after = await snapshotCounts();
  logSnapshot(after);

  const remainingMissing = sumMissing(after);
  if (remainingMissing > 0) {
    console.error(
      `\nFAILED: ${remainingMissing} row(s) still missing tenantId after backfill.`,
    );
    process.exit(1);
  }

  console.log('\nBackfill complete. All rows now have tenantId.');
  await prisma.$disconnect();
}

type CollectionSnapshot = { total: number; missing: number; hasValue: number };

async function snapshotCounts(): Promise<Record<string, CollectionSnapshot>> {
  const out: Record<string, CollectionSnapshot> = {};
  for (const col of TENANT_SCOPED_COLLECTIONS) {
    out[col] = {
      total: await rawCount(col, {}),
      missing: await rawCount(col, { tenantId: { $exists: false } }),
      hasValue: await rawCount(col, { tenantId: { $exists: true, $ne: null } }),
    };
  }
  return out;
}

async function rawCount(col: Collection, query: Record<string, unknown>): Promise<number> {
  const res = (await prisma.$runCommandRaw({
    count: col,
    query: query as Prisma.InputJsonObject,
  })) as { n?: number };
  return res.n ?? 0;
}

async function rawUpdateMissingTenantId(col: Collection, tenantId: string): Promise<number> {
  const res = (await prisma.$runCommandRaw({
    update: col,
    updates: [
      {
        q: { tenantId: { $exists: false } },
        u: { $set: { tenantId: { $oid: tenantId } } },
        multi: true,
      },
    ] as unknown as Prisma.InputJsonArray,
  })) as { nModified?: number; n?: number };
  return res.nModified ?? res.n ?? 0;
}

function logSnapshot(snap: Record<string, CollectionSnapshot>) {
  const width = Math.max(...Object.keys(snap).map((k) => k.length));
  for (const [col, s] of Object.entries(snap)) {
    console.log(
      `  ${col.padEnd(width)}  total=${s.total}  missing=${s.missing}  hasValue=${s.hasValue}`,
    );
  }
}

function sumMissing(snap: Record<string, CollectionSnapshot>): number {
  return Object.values(snap).reduce((acc, s) => acc + s.missing, 0);
}

main().catch(async (err) => {
  console.error('\nBackfill script error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
