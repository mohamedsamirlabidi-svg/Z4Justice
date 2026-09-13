/**
 * Payment-status backfill (F1a).
 *
 * Existing invoices carry a legacy `status` string (draft/sent/paid/overdue/verified/...).
 * The new `paymentStatus` field enum is (paid | pending | not_declared).
 *
 * Migration rule (kept intentionally narrow):
 *   status == 'paid' (case-insensitive) → paymentStatus = 'paid'
 *   everything else → leave paymentStatus at its default 'not_declared'
 *
 * We do NOT map 'overdue' → 'pending' automatically: F1b's flag worker will
 * derive flag color from dueDate + paymentStatus, so 'not_declared' is the
 * safe default until a human confirms a payment state.
 *
 * Usage:
 *   npx tsx prisma/backfill-payment-status.ts --dry-run
 *   npx tsx prisma/backfill-payment-status.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const mode = dryRun ? 'DRY RUN' : 'LIVE';
  console.log(`\n=== paymentStatus backfill (${mode}) ===\n`);

  // Distribution of legacy `status` values.
  const grouped = await prisma.invoice.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  console.log('Current status distribution:');
  for (const g of grouped) {
    console.log(`  ${(g.status ?? '(null)').padEnd(14)} ${g._count._all}`);
  }

  // Count how many docs would be migrated (case-insensitive on 'paid').
  const paidCount = (await prisma.$runCommandRaw({
    count: 'Invoice',
    query: { status: { $regex: '^paid$', $options: 'i' } },
  } as unknown as Prisma.InputJsonObject)) as { n?: number };

  const alreadyPaymentPaid = (await prisma.$runCommandRaw({
    count: 'Invoice',
    query: { paymentStatus: 'paid' },
  } as unknown as Prisma.InputJsonObject)) as { n?: number };

  console.log(`\nEligible for migration (status ~= 'paid'): ${paidCount.n ?? 0}`);
  console.log(`Already have paymentStatus == 'paid':       ${alreadyPaymentPaid.n ?? 0}`);

  if ((paidCount.n ?? 0) === 0) {
    console.log('\nNothing to migrate.');
    await prisma.$disconnect();
    return;
  }

  if (dryRun) {
    console.log(
      `\n[DRY RUN] Would set paymentStatus='paid' on ${paidCount.n} rows. Re-run without --dry-run to apply.`,
    );
    await prisma.$disconnect();
    return;
  }

  const result = (await prisma.$runCommandRaw({
    update: 'Invoice',
    updates: [
      {
        q: { status: { $regex: '^paid$', $options: 'i' } },
        u: { $set: { paymentStatus: 'paid' } },
        multi: true,
      },
    ],
  } as unknown as Prisma.InputJsonObject)) as { nModified?: number; n?: number };

  console.log(`\nUpdated rows: ${result.nModified ?? result.n ?? 0}`);

  const afterPaymentPaid = (await prisma.$runCommandRaw({
    count: 'Invoice',
    query: { paymentStatus: 'paid' },
  } as unknown as Prisma.InputJsonObject)) as { n?: number };
  console.log(`paymentStatus == 'paid' after migration: ${afterPaymentPaid.n ?? 0}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Backfill error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
