/**
 * Default admin seed. Post-F6, admin belongs to the default
 * "Acrobate Solution" tenant. Runs under runAsSystem so the guard skips
 * injection while we look up the tenant and create the user.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { runAsSystem } from '../src/tenant-context';

async function seedAdmin() {
  const email = 'admin@mini-erm.local';

  await runAsSystem('seed-admin', async () => {
    const tenant = await prisma.tenant.findFirst({ where: { slug: 'acrobate-solution' } });
    if (!tenant) {
      throw new Error(
        'Default tenant "acrobate-solution" not found. Run prisma/backfill-tenant.ts first.',
      );
    }

    const existing = await prisma.user.findFirst({ where: { email, tenantId: tenant.id } });
    if (existing) {
      console.log('Admin user already exists:', existing.email);
      return;
    }

    const passwordHash = await bcrypt.hash('admin123', 10);
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Administrateur',
        passwordHash,
        role: 'admin',
        tenantId: tenant.id,
      },
    });

    console.log('Default admin created:', user.email, '/ password: admin123');
  });
}

seedAdmin()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
