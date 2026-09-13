import { Request, Response, Router } from 'express';
import { prisma } from '../../prisma';
import { cacheGetOrSet, cacheDeleteByPrefix } from '../../cache';
import { currentTenantId } from '../../tenant-context';
import { authMiddleware } from '../auth/middleware';

export const productsRouter = Router();

// F6.2: every route on this router requires an authenticated tenant user.
productsRouter.use(authMiddleware);

const PRODUCTS_TTL = 60_000; // 60s

/* ── LIST with optional search / sort ── */
productsRouter.get('/', async (req: Request, res: Response) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const cacheKey = `products:list:${search}`;

  const products = await cacheGetOrSet(cacheKey, PRODUCTS_TTL, async () => {
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { sku: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    return prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true } } },
    });
  });

  res.json(products);
});

/* ── STATS (cached + parallelised) ── */
productsRouter.get('/stats', async (_req: Request, res: Response) => {
  const stats = await cacheGetOrSet('products:stats', 120_000, async () => {
    const [total, noName, noSku, zeroPrice, pending, verified, all] = await Promise.all([
      prisma.product.count(),
      prisma.product.count({ where: { name: '' } }),
      prisma.product.count({ where: { OR: [{ sku: null }, { sku: '' }] } }),
      prisma.product.count({ where: { unitPrice: { lte: 0 } } }),
      prisma.product.count({ where: { status: 'pending' } }),
      prisma.product.count({ where: { status: 'verified' } }),
      prisma.product.findMany({ select: { id: true, name: true, sku: true } }),
    ]);

    const seen = new Set<string>();
    let duplicates = 0;
    for (const p of all) {
      const key = `${(p.name || '').toLowerCase().trim()}|${(p.sku || '').toLowerCase().trim()}`;
      if (seen.has(key)) duplicates++;
      else seen.add(key);
    }

    return { total, noName, noSku, zeroPrice, duplicates, pending, verified };
  });

  res.json(stats);
});

/* ── CLEANUP: remove duplicates + products with missing essential data ── */
productsRouter.post('/cleanup', async (_req: Request, res: Response) => {
  let removedDuplicates = 0;
  let removedIncomplete = 0;

  // 1. Remove products with empty name or zero/negative price that have no invoice links
  const incomplete = await prisma.product.findMany({
    where: {
      OR: [
        { name: '' },
        { unitPrice: { lte: 0 } },
      ],
    },
    select: { id: true },
  });

  for (const p of incomplete) {
    const linked = await prisma.invoiceItem.count({ where: { productId: p.id } });
    if (linked === 0) {
      await prisma.product.delete({ where: { id: p.id } });
      removedIncomplete++;
    }
  }

  // 2. Remove duplicates: keep the first (oldest) product with same name+sku, delete the rest
  const allProducts = await prisma.product.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, sku: true },
  });

  const kept = new Map<string, string>(); // key → kept id
  const toDelete: string[] = [];

  for (const p of allProducts) {
    const key = `${(p.name || '').toLowerCase().trim()}|${(p.sku || '').toLowerCase().trim()}`;
    if (kept.has(key)) {
      toDelete.push(p.id);
    } else {
      kept.set(key, p.id);
    }
  }

  for (const id of toDelete) {
    const linked = await prisma.invoiceItem.count({ where: { productId: id } });
    if (linked === 0) {
      await prisma.product.delete({ where: { id } });
      removedDuplicates++;
    }
  }

  cacheDeleteByPrefix('products:');
  res.json({ removedDuplicates, removedIncomplete, total: removedDuplicates + removedIncomplete });
});

/* ── CREATE ── */
productsRouter.post('/', async (req: Request, res: Response) => {
  const { name, description, unitPrice, sku } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: 'Product name is required' });
  }
  const trimmedName = name.trim();
  const price = Number(unitPrice) || 0;
  const trimmedSku = sku?.trim() || null;
  const status = (price > 0 || trimmedSku) ? 'verified' : 'pending';
  const created = await prisma.product.create({
    data: { name: trimmedName, description: description?.trim() || null, unitPrice: price, sku: trimmedSku, status, tenantId: currentTenantId() }
  });
  cacheDeleteByPrefix('products:');
  res.status(201).json(created);
});

/* ── VERIFY / SET STATUS ── */
productsRouter.patch('/:id/status', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) return res.status(400).json({ message: 'Missing product id' });
  const { status } = req.body;
  if (status !== 'pending' && status !== 'verified') {
    return res.status(400).json({ message: 'Status must be "pending" or "verified"' });
  }
  const updated = await prisma.product.update({ where: { id }, data: { status } });
  cacheDeleteByPrefix('products:');
  res.json(updated);
});

/* ── UPDATE ── */
productsRouter.put('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ message: 'Missing product id' });
  }
  const { name, description, unitPrice, sku } = req.body;

  const trimmedName = name?.trim();
  const price = Number(unitPrice);
  const trimmedSku = sku?.trim() || null;
  const updated = await prisma.product.update({
    where: { id },
    data: {
      name: trimmedName,
      description: description?.trim() || null,
      unitPrice: price,
      sku: trimmedSku,
    }
  });

  cacheDeleteByPrefix('products:');
  res.json(updated);
});

/* ── DELETE ── */
productsRouter.delete('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ message: 'Missing product id' });
  }
  const usageCount = await prisma.invoiceItem.count({ where: { productId: id } });

  if (usageCount > 0) {
    return res.status(409).json({
      message: 'Cannot delete a product linked to invoices. Remove related invoices first.'
    });
  }

  await prisma.product.delete({ where: { id } });
  cacheDeleteByPrefix('products:');
  return res.status(204).send();
});
