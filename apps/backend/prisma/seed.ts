/**
 * Sample-data seed. Post-F6, this must run inside a tenant context.
 * We attach everything to the default "Acrobate Solution" tenant so this
 * script keeps working on local dev / new-machine setups.
 */
import { prisma } from '../src/prisma';
import { runAsSystem, runWithTenant } from '../src/tenant-context';

async function main() {
  // Resolve default tenant (created by the F6.3 backfill).
  const tenant = await runAsSystem('seed:lookup-tenant', () =>
    prisma.tenant.findFirst({ where: { slug: 'acrobate-solution' } }),
  );
  if (!tenant) {
    throw new Error(
      'Default tenant "acrobate-solution" not found. Run prisma/backfill-tenant.ts first.',
    );
  }

  await runWithTenant(tenant.id, async () => {
    const existingClient = await prisma.client.findFirst({
      where: { name: 'Acrobate Solution', company: 'Acrobate Solution' },
    });

    const client =
      existingClient ??
      (await prisma.client.create({
        data: { name: 'Acrobate Solution', company: 'Acrobate Solution', tenantId: tenant.id },
      }));

    const product = await prisma.product.create({
      data: {
        name: 'Safety Training Pack',
        sku: `TRAIN-${Date.now()}`,
        unitPrice: 199,
        tenantId: tenant.id,
      },
    });

    await prisma.invoice.create({
      data: {
        invoiceNo: `INV-${Date.now()}`,
        date: new Date(),
        status: 'draft',
        clientId: client.id,
        totalAmount: 199,
        tenantId: tenant.id,
        items: {
          create: {
            productId: product.id,
            quantity: 1,
            unitPrice: 199,
            lineTotal: 199,
            tenantId: tenant.id,
          },
        },
      },
    });
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
