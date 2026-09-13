/**
 * READ-ONLY forensics for the Acrobate data-loss incident.
 * Reports:
 *   1. Deletion timestamp (inferred from demo-tenant creation time — same seed run)
 *   2. Current counts per collection for Acrobate tenant vs demo tenant
 *   3. Sample check of ImportedFile.fullPath existence on disk (Plan B viability)
 *
 * NO WRITES. Safe to run any time.
 */
import fs from 'node:fs';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function rawCount(collection: string, query: Record<string, unknown>): Promise<number> {
  const r = (await prisma.$runCommandRaw({
    count: collection,
    query: query as Prisma.InputJsonObject,
  })) as { n?: number };
  return r.n ?? 0;
}

async function main() {
  const acrobate = await prisma.tenant.findFirst({ where: { slug: 'acrobate-solution' } });
  const demo = await prisma.tenant.findFirst({ where: { slug: 'demo-company' } });
  const testcorp = await prisma.tenant.findFirst({ where: { slug: 'test-corp-2' } });

  console.log('=== TENANTS ===');
  console.log(`acrobate-solution: id=${acrobate?.id}  createdAt=${acrobate?.createdAt.toISOString()}`);
  console.log(`demo-company:      id=${demo?.id}  createdAt=${demo?.createdAt.toISOString()}`);
  console.log(`test-corp-2:       id=${testcorp?.id}  createdAt=${testcorp?.createdAt.toISOString()}`);

  console.log('\n=== TIMESTAMP ANALYSIS ===');
  console.log('The deletion happened in the same seed run as the demo tenant creation.');
  console.log(`Best estimate of deletion time: ${demo?.createdAt.toISOString() ?? 'unknown'}`);
  console.log('This bounds it: everything wiped happened within ~1-2 minutes AFTER this timestamp.');

  console.log('\n=== CURRENT COUNTS PER TENANT ===');
  console.log(
    `${'Collection'.padEnd(18)} ${'total'.padStart(8)} ${'acrobate'.padStart(10)} ${'demo'.padStart(8)} ${'test-corp-2'.padStart(12)}`,
  );
  console.log('-'.repeat(60));
  const collections = ['Client', 'Product', 'Invoice', 'InvoiceItem', 'ImportedFile', 'NotificationLog', 'User', 'TenantApiKey'];
  const results: Array<{ col: string; total: number; acro: number; demo: number; tc2: number }> = [];
  for (const col of collections) {
    const total = await rawCount(col, {});
    const acro = acrobate ? await rawCount(col, { tenantId: { $oid: acrobate.id } }) : 0;
    const d = demo ? await rawCount(col, { tenantId: { $oid: demo.id } }) : 0;
    const tc2 = testcorp ? await rawCount(col, { tenantId: { $oid: testcorp.id } }) : 0;
    console.log(`${col.padEnd(18)} ${String(total).padStart(8)} ${String(acro).padStart(10)} ${String(d).padStart(8)} ${String(tc2).padStart(12)}`);
    results.push({ col, total, acro, demo: d, tc2 });
  }

  console.log('\n=== ACROBATE LOSS SUMMARY (compared to pre-incident totals) ===');
  const pre = { Client: 1117, Product: 1615, Invoice: 2461, InvoiceItem: 5142, ImportedFile: 4090, NotificationLog: 0, User: 3, TenantApiKey: 0 };
  console.log(`${'Collection'.padEnd(18)} ${'before'.padStart(8)} ${'now'.padStart(8)} ${'lost'.padStart(8)} status`);
  console.log('-'.repeat(60));
  for (const r of results) {
    const before = (pre as Record<string, number>)[r.col] ?? 0;
    const lost = Math.max(0, before - r.acro);
    const status = before === 0 ? '(n/a)' : r.acro === before ? '✅ intact' : r.acro === 0 ? '❌ wiped' : `⚠️  partial (${((r.acro/before)*100).toFixed(0)}% remain)`;
    console.log(`${r.col.padEnd(18)} ${String(before).padStart(8)} ${String(r.acro).padStart(8)} ${String(lost).padStart(8)} ${status}`);
  }

  // ── PLAN B VIABILITY: check if ImportedFile.fullPath still exists on disk ──
  console.log('\n=== PLAN B VIABILITY: ImportedFile paths on disk ===');
  if (!acrobate) {
    console.log('No acrobate tenant — cannot check.');
    await prisma.$disconnect();
    return;
  }

  // Fetch a sample of ImportedFile fullPaths for Acrobate.
  const sampleRaw = (await prisma.$runCommandRaw({
    find: 'ImportedFile',
    filter: { tenantId: { $oid: acrobate.id } },
    projection: { fullPath: 1, status: 1, extension: 1, filename: 1 },
    limit: 20,
  } as unknown as Prisma.InputJsonObject)) as { cursor?: { firstBatch?: Array<{ fullPath: string; status: string; extension: string; filename: string }> } };
  const sample = sampleRaw.cursor?.firstBatch ?? [];
  console.log(`Sample of ${sample.length} of ${results.find(r => r.col === 'ImportedFile')?.acro ?? '?'} ImportedFile rows:`);
  let existing = 0;
  let missing = 0;
  for (const row of sample) {
    const exists = fs.existsSync(row.fullPath);
    console.log(`  ${exists ? '✅' : '❌'}  ${row.status.padEnd(10)}  ${row.fullPath}`);
    if (exists) existing++; else missing++;
  }
  const rate = sample.length ? Math.round((existing / sample.length) * 100) : 0;
  console.log(`\nSample result: ${existing}/${sample.length} exist on disk (${rate}%)`);

  if (existing > 0) {
    console.log('\n=== FULL DISK CHECK (all Acrobate ImportedFile paths) ===');
    console.log('Streaming all rows to count file-exists precisely…');
    let checked = 0;
    let allExisting = 0;
    let allMissing = 0;
    const byExtStats: Record<string, { existing: number; missing: number }> = {};

    // Use $runCommandRaw with paginated find to avoid a massive in-memory array.
    let cursor: string | null = null;
    // Simpler: use Prisma with a large take (4091 rows is fine to hold in memory as {fullPath, extension}).
    void cursor;
    const allRaw = (await prisma.$runCommandRaw({
      find: 'ImportedFile',
      filter: { tenantId: { $oid: acrobate.id } },
      projection: { fullPath: 1, extension: 1 },
      limit: 10000,
    } as unknown as Prisma.InputJsonObject)) as { cursor?: { firstBatch?: Array<{ fullPath: string; extension: string }> } };
    const all = allRaw.cursor?.firstBatch ?? [];
    for (const row of all) {
      checked += 1;
      const ext = (row.extension ?? '').toLowerCase();
      byExtStats[ext] = byExtStats[ext] ?? { existing: 0, missing: 0 };
      if (fs.existsSync(row.fullPath)) {
        allExisting += 1;
        byExtStats[ext].existing += 1;
      } else {
        allMissing += 1;
        byExtStats[ext].missing += 1;
      }
    }
    const allRate = checked ? Math.round((allExisting / checked) * 100) : 0;
    console.log(`Full result: ${allExisting}/${checked} exist on disk (${allRate}%)`);
    console.log('\nBy extension:');
    for (const [ext, s] of Object.entries(byExtStats)) {
      const totalExt = s.existing + s.missing;
      const pct = totalExt ? Math.round((s.existing / totalExt) * 100) : 0;
      console.log(`  ${(ext || '(none)').padEnd(8)}  ${s.existing}/${totalExt}  (${pct}%)`);
    }

    console.log('\n=== PLAN B READINESS ===');
    if (allRate >= 90) {
      console.log(`✅ Plan B is fully viable — ${allExisting} source files still on disk.`);
      console.log('   Re-ingest script would reconstruct Client + Product + Invoice + InvoiceItem records.');
      console.log('   Estimated run time: 15-30 minutes (depending on Flask parser availability).');
    } else if (allRate >= 50) {
      console.log(`⚠️  Plan B is partially viable — ${allExisting} of ${checked} files (${allRate}%) still on disk.`);
      console.log(`   Would recover ${allExisting} invoices/clients; ${allMissing} would remain lost.`);
    } else {
      console.log(`❌ Plan B is not viable — only ${allExisting} of ${checked} files (${allRate}%) still on disk.`);
      console.log('   Atlas restore is the only realistic recovery path.');
    }
  } else {
    console.log('\n❌ PLAN B NOT VIABLE: none of the sampled files exist on disk.');
    console.log('   Atlas restore is the only recovery option.');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Forensics error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
