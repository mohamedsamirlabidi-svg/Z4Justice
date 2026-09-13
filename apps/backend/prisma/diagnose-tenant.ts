/**
 * Diagnostic-only: compare Prisma's view of tenantId presence against raw MongoDB.
 * No writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const collections = ['Client', 'Product', 'Invoice', 'InvoiceItem', 'ImportedFile', 'User'];

  console.log('\n=== Raw MongoDB view (via $runCommandRaw) ===\n');
  for (const col of collections) {
    const totalResult = (await prisma.$runCommandRaw({
      count: col,
      query: {},
    })) as { n?: number };
    const missingResult = (await prisma.$runCommandRaw({
      count: col,
      query: { tenantId: { $exists: false } },
    })) as { n?: number };
    const nullResult = (await prisma.$runCommandRaw({
      count: col,
      query: { tenantId: null },
    })) as { n?: number };
    const hasValueResult = (await prisma.$runCommandRaw({
      count: col,
      query: { tenantId: { $exists: true, $ne: null } },
    })) as { n?: number };

    console.log(
      `${col.padEnd(14)}  total=${totalResult.n ?? '?'}  tenantId_missing=${missingResult.n ?? '?'}  tenantId_null=${nullResult.n ?? '?'}  tenantId_hasValue=${hasValueResult.n ?? '?'}`,
    );
  }

  console.log('\n=== Sample docs (first row of Client, first row of Invoice) ===\n');
  const sampleClient = (await prisma.$runCommandRaw({
    find: 'Client',
    limit: 1,
  })) as { cursor?: { firstBatch?: unknown[] } };
  console.log('Client sample:', JSON.stringify(sampleClient.cursor?.firstBatch?.[0], null, 2));

  const sampleInvoice = (await prisma.$runCommandRaw({
    find: 'Invoice',
    limit: 1,
  })) as { cursor?: { firstBatch?: unknown[] } };
  console.log('Invoice sample keys:', Object.keys((sampleInvoice.cursor?.firstBatch?.[0] as object) ?? {}));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
