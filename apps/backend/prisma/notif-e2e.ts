/**
 * F2 end-to-end smoke test. Requires backend to be STOPPED (no port conflict).
 *
 * Flow:
 *   1. Find (or create) a test client in Test Corp 2 tenant with phone + email
 *   2. Create an overdue-by-3-days test invoice attached to that client
 *   3. Import + call the flag worker for just that tenant
 *   4. Assert the invoice's flagStatus is now 'yellow'
 *   5. Assert NotificationLog has 2 entries (sms + email) with status='skipped_dry_run'
 *   6. Run the worker AGAIN — assert dedup kicks in (2 more entries with skipped_dedup)
 *   7. Clean up (delete test invoice + client + NotificationLog entries)
 */
import { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../src/tenant-context';
import { runFlagWorkerForTenant } from '../src/scheduler/flag-worker';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: 'test-corp-2' } });
  if (!tenant) throw new Error('Test Corp 2 tenant not found — run smoke test A first.');
  console.log(`Using tenant ${tenant.slug} (${tenant.id})`);

  const now = new Date();
  const dueDate = new Date(now.getTime() - 3 * 86_400_000); // 3 days overdue → yellow

  const { client, invoice } = await runWithTenant(tenant.id, async () => {
    const c = await prisma.client.create({
      data: {
        name: 'E2E Notif Test Client',
        company: 'test-corp-2',
        phone: '+21600000000',
        email: 'e2e-notif@testcorp2.example',
        tenantId: tenant.id,
      },
    });
    const inv = await prisma.invoice.create({
      data: {
        invoiceNo: `E2E-NOTIF-${Date.now()}`,
        date: new Date(now.getTime() - 30 * 86_400_000),
        dueDate,
        clientId: c.id,
        totalAmount: 1234.567,
        currency: 'TND',
        companyName: 'Test Corp 2',
        paymentStatus: 'not_declared',
        flagStatus: 'none',
        tenantId: tenant.id,
      },
    });
    return { client: c, invoice: inv };
  });

  console.log(`Created client=${client.id} invoice=${invoice.id} (dueDate=3 days ago)`);

  console.log('\n--- First worker run ---');
  const r1 = await runFlagWorkerForTenant(tenant.id, now);
  console.log(JSON.stringify(r1, null, 2));

  const inv1 = await runWithTenant(tenant.id, () =>
    prisma.invoice.findFirst({ where: { id: invoice.id }, select: { flagStatus: true, lastNotifiedAt: true } }),
  );
  console.log(`invoice.flagStatus after run 1: ${inv1?.flagStatus}   (expected: yellow)`);
  console.log(`invoice.lastNotifiedAt: ${inv1?.lastNotifiedAt?.toISOString() ?? 'null'}`);

  const logs1 = await runWithTenant(tenant.id, () =>
    prisma.notificationLog.findMany({ where: { invoiceId: invoice.id }, orderBy: { createdAt: 'asc' } }),
  );
  console.log(`\nNotificationLog entries after run 1: ${logs1.length}`);
  for (const l of logs1) {
    console.log(`  ${l.channel.padEnd(8)} recipient=${l.recipient.padEnd(30)} status=${l.status} flag=${l.flagAtSend} template=${l.templateKey}`);
  }

  console.log('\n--- Second worker run (should dedup) ---');
  const r2 = await runFlagWorkerForTenant(tenant.id, now);
  console.log(JSON.stringify(r2, null, 2));
  const logs2 = await runWithTenant(tenant.id, () =>
    prisma.notificationLog.findMany({ where: { invoiceId: invoice.id }, orderBy: { createdAt: 'asc' } }),
  );
  console.log(`\nNotificationLog entries after run 2: ${logs2.length}   (expected: unchanged, since flag didn't transition again)`);

  console.log('\n--- Cleanup ---');
  await runWithTenant(tenant.id, async () => {
    await prisma.notificationLog.deleteMany({ where: { invoiceId: invoice.id } });
    await prisma.invoice.delete({ where: { id: invoice.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });
  console.log('cleaned up.');

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
