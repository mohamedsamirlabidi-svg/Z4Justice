import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../prisma';
import { runAsSystem, runWithTenant } from '../../tenant-context';
import { hashApiKey, mintApiKeyPlain, prefixFor } from '../api-keys/service';
import { authMiddleware, signToken } from './middleware';

export const authRouter = Router();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function pickUniqueTenantSlug(desired: string): Promise<string> {
  const base = slugify(desired) || 'tenant';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const clash = await prisma.tenant.findUnique({ where: { slug: candidate } });
    if (!clash) return candidate;
  }
  // Fallback: base + short random suffix. Vanishingly unlikely to be needed.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

// POST /api/auth/login
authRouter.post('/login', async (req, res) => {
  const { email, password, tenantSlug } = req.body as {
    email?: string;
    password?: string;
    tenantSlug?: string;
  };
  if (!email || !password) {
    return res.status(400).json({ message: 'Email et mot de passe requis' });
  }

  // Login runs before any tenant context exists — email is no longer globally
  // unique, so we look up every user with this email across tenants and match
  // the one whose password verifies.
  const candidates = await runAsSystem('login', () =>
    prisma.user.findMany({
      where: {
        email,
        ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
      },
      include: { tenant: { select: { id: true, slug: true, name: true, isActive: true } } },
    }),
  );

  const matches: typeof candidates = [];
  for (const candidate of candidates) {
    if (await bcrypt.compare(password, candidate.passwordHash)) {
      matches.push(candidate);
    }
  }

  if (matches.length === 0) {
    return res.status(401).json({ message: 'Identifiants invalides' });
  }

  if (matches.length > 1) {
    return res.status(409).json({
      message: 'Ce compte existe sur plusieurs tenants. Précisez tenantSlug.',
      tenants: matches
        .map((u) => (u.tenant ? { slug: u.tenant.slug, name: u.tenant.name } : null))
        .filter(Boolean),
    });
  }

  const user = matches[0];
  if (user.tenant && !user.tenant.isActive) {
    return res.status(403).json({ message: 'Ce tenant est désactivé.' });
  }

  const token = signToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId ?? null,
    platformAdmin: user.platformAdmin,
  });

  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      platformAdmin: user.platformAdmin,
      tenant: user.tenant ? { id: user.tenant.id, slug: user.tenant.slug, name: user.tenant.name } : null,
    },
  });
});

// POST /api/auth/signup — create a new tenant with a first admin user and API key.
authRouter.post('/signup', async (req, res) => {
  const { companyName, tenantSlug, adminName, adminEmail, password } = req.body as {
    companyName?: string;
    tenantSlug?: string;
    adminName?: string;
    adminEmail?: string;
    password?: string;
  };

  if (!companyName || !adminName || !adminEmail || !password) {
    return res.status(400).json({
      message: 'companyName, adminName, adminEmail, and password are required.',
    });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return res.status(400).json({ message: 'adminEmail is not a valid email address.' });
  }

  return runAsSystem('signup', async () => {
    // Slug uniqueness is enforced globally.
    const slug = await pickUniqueTenantSlug(tenantSlug || companyName);

    const tenant = await prisma.tenant.create({
      data: {
        name: companyName.trim(),
        slug,
        plan: 'free',
        isActive: true,
      },
    });

    // Create the admin user + first API key inside the new tenant's context so
    // the tenant guard injects tenantId automatically. We're still under
    // runAsSystem for slug lookup, so we wrap the writes explicitly.
    const passwordHash = await bcrypt.hash(password, 10);

    const { user, apiKeyPlain, apiKeyMeta } = await runWithTenant(tenant.id, async () => {
      const createdUser = await prisma.user.create({
        data: {
          email: adminEmail.trim(),
          name: adminName.trim(),
          passwordHash,
          role: 'admin',
          tenantId: tenant.id,
        },
      });

      const plain = mintApiKeyPlain();
      const meta = await prisma.tenantApiKey.create({
        data: {
          name: 'Default agent key (created at signup)',
          keyPrefix: prefixFor(plain),
          keyHash: hashApiKey(plain),
          tenantId: tenant.id,
          createdBy: createdUser.id,
        },
        select: { id: true, name: true, keyPrefix: true, createdAt: true },
      });

      return { user: createdUser, apiKeyPlain: plain, apiKeyMeta: meta };
    });

    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: tenant.id,
      platformAdmin: false,
    });

    return res.status(201).json({
      token,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, plan: tenant.plan },
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      apiKey: {
        ...apiKeyMeta,
        key: apiKeyPlain,
        warning:
          'This plaintext key is shown only once. Copy it now — you will not be able to retrieve it again.',
      },
    });
  });
});

// GET /api/auth/me
authRouter.get('/me', authMiddleware, async (req, res) => {
  // Under authMiddleware the tenant context is already set (or system for platform admins),
  // so findUnique here goes through the tenant guard automatically.
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
  });
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }
  return res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    platformAdmin: user.platformAdmin,
    tenant: user.tenant ? { id: user.tenant.id, slug: user.tenant.slug, name: user.tenant.name } : null,
  });
});
