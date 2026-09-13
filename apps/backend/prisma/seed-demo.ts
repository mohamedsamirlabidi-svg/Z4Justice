/**
 * Demo seed (F-demo).
 *
 * Creates a fresh "Demo Company" tenant with:
 *   - Admin login: demo@demo.local / demo1234
 *   - 6 realistic Tunisian companies as clients (with phone, email, address)
 *   - ~20 invoices spread across all flag states (red / orange / yellow / green / none)
 *   - Facture + Devis + Bon de livraison variants
 *   - Pre-populated NotificationLog entries so the notification timeline isn't empty
 *
 * Idempotent: rerunning wipes and reseeds the demo tenant's client/invoice/notif data.
 *
 * Usage:
 *   npx tsx prisma/seed-demo.ts
 */
import bcrypt from 'bcryptjs';
// IMPORTANT: import the tenant-guarded client, NOT `new PrismaClient()`.
// A previous version of this script created its own base client, which
// bypassed the guard and wiped tenant-scoped data across ALL tenants.
import { prisma } from '../src/prisma';
import { currentTenantId, runWithTenant } from '../src/tenant-context';
const DAY = 86_400_000;

async function main() {
  const now = new Date();

  // ── 1. Tenant (Tenant model is not guarded) ──
  let tenant = await prisma.tenant.findFirst({ where: { slug: 'demo-company' } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { name: 'Demo Company', slug: 'demo-company', plan: 'pro', isActive: true },
    });
    console.log(`Created tenant ${tenant.slug} (${tenant.id})`);
  } else {
    console.log(`Reusing tenant ${tenant.slug} (${tenant.id})`);
  }

  // Everything else runs INSIDE the tenant scope so the extension auto-injects tenantId.
  await runWithTenant(tenant.id, async () => {
    // ── 2. Admin user ──
    const existingAdmin = await prisma.user.findFirst({ where: { email: 'demo@demo.local' } });
    if (!existingAdmin) {
      await prisma.user.create({
        data: {
          email: 'demo@demo.local',
          name: 'Demo Admin',
          passwordHash: await bcrypt.hash('demo1234', 10),
          role: 'admin',
          tenantId: tenant.id,
        },
      });
      console.log('Created admin: demo@demo.local / demo1234');
    } else {
      console.log('Admin already exists: demo@demo.local / demo1234');
    }

    // ── 3. Wipe previous demo-tenant data (explicit tenantId filter per guard safety net) ──
    const tid = currentTenantId();
    const scoped = { where: { tenantId: tid } };
    const wipedNotifs = await prisma.notificationLog.deleteMany(scoped);
    const wipedItems = await prisma.invoiceItem.deleteMany(scoped);
    const wipedInvoices = await prisma.invoice.deleteMany(scoped);
    const wipedClients = await prisma.client.deleteMany(scoped);
    const wipedProducts = await prisma.product.deleteMany(scoped);
    console.log(
      `Wiped previous demo data: ${wipedClients.count} clients, ${wipedInvoices.count} invoices, `
        + `${wipedItems.count} items, ${wipedProducts.count} products, ${wipedNotifs.count} notif logs`,
    );

    // ── 4. Clients (realistic Tunisian companies) ──
    const clientsData: Array<{
      name: string;
      email: string;
      phone: string;
      address: string;
    }> = [
      {
        name: 'SOTETEL',
        email: 'compta@sotetel.tn',
        phone: '+21671123456',
        address: 'Rue Yasser Arafat, Tunis 1002',
      },
      {
        name: 'HUAWEI Tunisie',
        email: 'invoices@huawei.tn',
        phone: '+21671898765',
        address: 'Les Berges du Lac 2, Tunis 1053',
      },
      {
        name: 'OMNIACOM',
        email: 'admin@omniacom.com.tn',
        phone: '+21674555444',
        address: 'Avenue Habib Bourguiba, Sfax 3000',
      },
      {
        name: 'STEG',
        email: 'fournisseurs@steg.com.tn',
        phone: '+21671341234',
        address: 'Rue Colombie, Tunis 1001',
      },
      {
        name: 'Tunisie Telecom',
        email: 'entreprises@tt.com.tn',
        phone: '+21671840840',
        address: 'Rue de la Monnaie, Tunis 1002',
      },
      {
        name: 'BIAT',
        email: 'achats@biat.com.tn',
        phone: '+21671520520',
        address: 'Avenue Habib Bourguiba, Tunis 1001',
      },
    ];

    const clients: Array<{ id: string; name: string; email: string; phone: string }> = [];
    for (const c of clientsData) {
      const created = await prisma.client.create({
        data: {
          name: c.name,
          email: c.email,
          phone: c.phone,
          company: 'DEMO_COMPANY',
          tenantId: tenant.id,
        },
      });
      clients.push({ id: created.id, name: c.name, email: c.email, phone: c.phone });
    }
    console.log(`Created ${clients.length} clients`);

    // ── 5. Products (for invoice items) ──
    const productDefs = [
      { name: 'Formation Sécurité au travail', sku: 'FORM-SEC-01', unitPrice: 850 },
      { name: 'Audit ISO 45001', sku: 'AUDIT-ISO', unitPrice: 3500 },
      { name: 'Équipement EPI complet', sku: 'EPI-PACK', unitPrice: 250 },
      { name: 'Licence Logiciel Annuelle', sku: 'LIC-YR', unitPrice: 1200 },
      { name: 'Support Technique Mensuel', sku: 'SUPP-MONTH', unitPrice: 500 },
      { name: 'Consultation Expert', sku: 'CONSULT-HR', unitPrice: 180 },
    ];
    const products: Array<{ id: string; name: string; unitPrice: number }> = [];
    for (const p of productDefs) {
      const created = await prisma.product.create({
        data: { ...p, status: 'verified', tenantId: tenant.id },
      });
      products.push({ id: created.id, name: created.name, unitPrice: created.unitPrice });
    }
    console.log(`Created ${products.length} products`);

    // ── 6. Invoices with pre-computed flag colors ──
    type Spec = {
      clientIdx: number;
      dueDaysAgo: number; // negative = future
      paymentStatus: 'paid' | 'pending' | 'not_declared';
      doc: 'facture' | 'devis' | 'bon_de_livraison';
      amount: number;
      productIdx: number;
    };
    const specs: Spec[] = [
      // 2 RED (> 30 days overdue)
      { clientIdx: 0, dueDaysAgo: 62, paymentStatus: 'pending', doc: 'facture', amount: 12300, productIdx: 1 },
      { clientIdx: 3, dueDaysAgo: 45, paymentStatus: 'not_declared', doc: 'facture', amount: 8500, productIdx: 0 },
      // 2 ORANGE (8-30 days overdue)
      { clientIdx: 2, dueDaysAgo: 22, paymentStatus: 'pending', doc: 'facture', amount: 6750, productIdx: 3 },
      { clientIdx: 1, dueDaysAgo: 15, paymentStatus: 'not_declared', doc: 'facture', amount: 4200, productIdx: 4 },
      // 2 YELLOW (1-7 days overdue)
      { clientIdx: 4, dueDaysAgo: 5, paymentStatus: 'not_declared', doc: 'facture', amount: 3800, productIdx: 2 },
      { clientIdx: 5, dueDaysAgo: 3, paymentStatus: 'not_declared', doc: 'facture', amount: 2100, productIdx: 5 },
      // 3 GREEN (paid, previously overdue or on time)
      { clientIdx: 0, dueDaysAgo: 20, paymentStatus: 'paid', doc: 'facture', amount: 5500, productIdx: 4 },
      { clientIdx: 2, dueDaysAgo: 40, paymentStatus: 'paid', doc: 'facture', amount: 9200, productIdx: 1 },
      { clientIdx: 4, dueDaysAgo: 8, paymentStatus: 'paid', doc: 'facture', amount: 1750, productIdx: 2 },
      // 3 NONE (not yet due)
      { clientIdx: 1, dueDaysAgo: -10, paymentStatus: 'not_declared', doc: 'facture', amount: 3200, productIdx: 3 },
      { clientIdx: 3, dueDaysAgo: -20, paymentStatus: 'not_declared', doc: 'facture', amount: 4800, productIdx: 0 },
      { clientIdx: 5, dueDaysAgo: -5, paymentStatus: 'not_declared', doc: 'facture', amount: 2900, productIdx: 5 },
      // 2 devis (proposals, dueDaysAgo used as validity date)
      { clientIdx: 0, dueDaysAgo: -30, paymentStatus: 'not_declared', doc: 'devis', amount: 15200, productIdx: 1 },
      { clientIdx: 2, dueDaysAgo: -15, paymentStatus: 'not_declared', doc: 'devis', amount: 7500, productIdx: 3 },
      // 2 bon de livraison
      { clientIdx: 1, dueDaysAgo: -3, paymentStatus: 'not_declared', doc: 'bon_de_livraison', amount: 800, productIdx: 2 },
      { clientIdx: 4, dueDaysAgo: -8, paymentStatus: 'not_declared', doc: 'bon_de_livraison', amount: 1400, productIdx: 2 },
    ];

    function flagFor(s: Spec): 'green' | 'yellow' | 'orange' | 'red' | 'none' {
      if (s.paymentStatus === 'paid') return 'green';
      if (s.dueDaysAgo <= 0) return 'none';
      if (s.dueDaysAgo <= 7) return 'yellow';
      if (s.dueDaysAgo <= 30) return 'orange';
      return 'red';
    }

    type SeededInvoice = {
      id: string;
      invoiceNo: string;
      flagStatus: 'green' | 'yellow' | 'orange' | 'red' | 'none';
      client: (typeof clients)[number];
    };
    const createdInvoices: SeededInvoice[] = [];
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const client = clients[s.clientIdx];
      const product = products[s.productIdx];
      const dueDate = new Date(now.getTime() - s.dueDaysAgo * DAY);
      const issueDate = new Date(dueDate.getTime() - 30 * DAY);
      const flagStatus = flagFor(s);
      const invoiceNo = `DEMO-${s.doc.toUpperCase().slice(0, 3)}-${(1000 + i).toString().padStart(4, '0')}`;

      const invoice = await prisma.invoice.create({
        data: {
          invoiceNo,
          date: issueDate,
          dueDate,
          status: s.paymentStatus === 'paid' ? 'paid' : 'sent',
          paymentStatus: s.paymentStatus,
          flagStatus,
          flagUpdatedAt: now,
          clientId: client.id,
          totalAmount: s.amount,
          totalHT: Math.round(s.amount / 1.19 * 100) / 100,
          taxRate: 0.19,
          taxAmount: Math.round((s.amount - s.amount / 1.19) * 100) / 100,
          currency: 'TND',
          documentType: s.doc,
          companyName: 'Demo Company',
          companyEmail: 'admin@demo.local',
          companyPhone: '+21671000000',
          tenantId: tenant.id,
          items: {
            create: [
              {
                productId: product.id,
                description: product.name,
                quantity: 1,
                unitPrice: s.amount,
                lineTotal: s.amount,
                tenantId: tenant.id,
              },
            ],
          },
        },
      });
      createdInvoices.push({ id: invoice.id, invoiceNo, flagStatus, client });
    }
    console.log(
      `Created ${createdInvoices.length} invoices — `
        + `red=${createdInvoices.filter((i) => i.flagStatus === 'red').length}, `
        + `orange=${createdInvoices.filter((i) => i.flagStatus === 'orange').length}, `
        + `yellow=${createdInvoices.filter((i) => i.flagStatus === 'yellow').length}, `
        + `green=${createdInvoices.filter((i) => i.flagStatus === 'green').length}, `
        + `none=${createdInvoices.filter((i) => i.flagStatus === 'none').length}`,
    );

    // ── 7. NotificationLog for red/orange/yellow invoices (historical) ──
    let notifCount = 0;
    for (const inv of createdInvoices) {
      if (!['red', 'orange', 'yellow'].includes(inv.flagStatus)) continue;

      const templateKey =
        inv.flagStatus === 'red' ? 'red-final-warning'
          : inv.flagStatus === 'orange' ? 'orange-firmer'
            : 'yellow-reminder';
      const channels: Array<'sms' | 'email' | 'whatsapp'> = inv.flagStatus === 'yellow'
        ? ['sms', 'email']
        : ['sms', 'email', 'whatsapp'];

      // Simulate the notification firing 1-3 days ago.
      const notifiedAt = new Date(now.getTime() - (1 + Math.floor(Math.random() * 3)) * DAY);
      for (const ch of channels) {
        const recipient = ch === 'email' ? inv.client.email : inv.client.phone;
        await prisma.notificationLog.create({
          data: {
            tenantId: tenant.id,
            invoiceId: inv.id,
            clientId: inv.client.id,
            channel: ch,
            recipient: recipient || '(missing)',
            status: 'skipped_dry_run',
            templateKey,
            flagAtSend: inv.flagStatus,
            contentPreview:
              `Bonjour ${inv.client.name}, la facture ${inv.invoiceNo} est en retard de règlement…`,
            createdAt: notifiedAt,
          },
        });
        notifCount += 1;
      }
      // Also stamp lastNotifiedAt on the invoice so the UI shows the timing.
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { lastNotifiedAt: notifiedAt },
      });
    }
    console.log(`Created ${notifCount} historical NotificationLog entries`);
  });

  console.log('\n✔ Demo seed complete.');
  console.log('   Login: demo@demo.local / demo1234');
  console.log('   Tenant slug: demo-company');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Seed error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
