import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { cacheClear, cacheGetOrSet } from '../../cache';
import { currentTenantId } from '../../tenant-context';
import { authMiddleware } from '../auth/middleware';

export const clientsRouter = Router();

// F6.2: every route on this router requires an authenticated tenant user.
clientsRouter.use(authMiddleware);

type CompanyKey = 'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS' | 'UNKNOWN';
type DocumentType = 'facture' | 'devis' | 'bon_de_livraison' | 'unknown';

function detectCompany(values: Array<string | null | undefined>): CompanyKey {
  for (const value of values) {
    const normalized = (value ?? '').toLowerCase();
    if (!normalized) continue;
    if (normalized.includes('acrobate_solution')) return 'ACROBATE_SOLUTION';
    if (normalized.includes('gamestream_atlas')) return 'GAMESTREAM_ATLAS';
    if (normalized.includes('acrobate')) return 'ACROBATE_SOLUTION';
    if (normalized.includes('gamestream') || normalized.includes('atlas')) return 'GAMESTREAM_ATLAS';
  }
  return 'UNKNOWN';
}

function detectDocumentType(values: Array<string | null | undefined>): DocumentType {
  for (const value of values) {
    const normalized = (value ?? '').toLowerCase();
    if (!normalized) continue;
    if (
      normalized.includes('/bon de livraison/') ||
      normalized.includes('\\bon de livraison\\') ||
      normalized.includes('/bon de liv/') ||
      normalized.includes('\\bon de liv\\') ||
      normalized.includes('/bl/') ||
      normalized.includes('\\bl\\') ||
      /(^|[\s._\\/-])(bon\s*de\s*livraison|bon\s*de\s*liv|delivery\s*note|bl)([\s._\\/-]|$)/i.test(normalized)
    ) {
      return 'bon_de_livraison';
    }
    if (
      normalized.includes('/devis/') ||
      normalized.includes('\\devis\\') ||
      /(^|[\s._\\/-])(devis|quote|quotation|offre(?:\s+de\s+prix)?)([\s._\\/-]|$)/i.test(normalized)
    ) {
      return 'devis';
    }
    if (
      normalized.includes('/facture/') ||
      normalized.includes('\\facture\\') ||
      /(^|[\s._\\/-])(facture|invoice|inv)([\s._\\/-]|$)/i.test(normalized)
    ) {
      return 'facture';
    }
  }
  return 'unknown';
}

function normalizeDocumentType(input?: string): DocumentType | undefined {
  if (!input) return undefined;
  const normalized = input.trim().toLowerCase();
  if (normalized === 'facture' || normalized === 'invoice') return 'facture';
  if (normalized === 'devis' || normalized === 'quote' || normalized === 'quotation') return 'devis';
  if (
    normalized === 'bon_de_livraison' ||
    normalized === 'bon-de-livraison' ||
    normalized === 'bon de livraison' ||
    normalized === 'bl' ||
    normalized === 'delivery_note' ||
    normalized === 'delivery-note' ||
    normalized === 'delivery note'
  ) return 'bon_de_livraison';
  if (normalized === 'unknown') return 'unknown';
  return undefined;
}

function companyInvoiceWhere(company?: string): Prisma.InvoiceWhereInput | undefined {
  if (company === 'ACROBATE_SOLUTION') {
    return {
      OR: [
        { client: { company: 'ACROBATE_SOLUTION' } },
        { client: { company: 'Acrobate Solution' } },
        { companyName: { contains: 'acrobate' } },
        { sourceFile: { contains: 'ACROBATE' } },
        { sourceFile: { contains: 'Acrobate' } }
      ]
    } as Prisma.InvoiceWhereInput;
  }

  if (company === 'GAMESTREAM_ATLAS') {
    return {
      OR: [
        { client: { company: 'GAMESTREAM_ATLAS' } },
        { client: { company: 'GameStream ATLAS' } },
        { companyName: { contains: 'gamestream' } },
        { companyName: { contains: 'atlas' } },
        { sourceFile: { contains: 'GAMESTREAM' } },
        { sourceFile: { contains: 'GameStream' } }
      ]
    } as Prisma.InvoiceWhereInput;
  }

  return undefined;
}

function documentTypeInvoiceWhere(documentType?: DocumentType): Prisma.InvoiceWhereInput | undefined {
  if (documentType === 'devis') {
    return {
      OR: [
        { sourceFile: { contains: 'devis' } },
        { sourceFile: { contains: 'DEVIS' } },
        { sourceFile: { contains: 'offre' } },
        { sourceFile: { contains: 'quotation' } },
        { sourceFile: { contains: 'quote' } },
        { invoiceNo: { contains: 'DEVIS' } }
      ]
    } as Prisma.InvoiceWhereInput;
  }

  if (documentType === 'facture') {
    return {
      OR: [
        { sourceFile: { contains: 'facture' } },
        { sourceFile: { contains: 'FACTURE' } },
        { sourceFile: { contains: 'invoice' } },
        { invoiceNo: { contains: 'FAC' } },
        { invoiceNo: { contains: 'FACT' } }
      ]
    } as Prisma.InvoiceWhereInput;
  }

  if (documentType === 'bon_de_livraison') {
    return {
      OR: [
        { sourceFile: { contains: 'BON DE LIVRAISON' } },
        { sourceFile: { contains: 'bon de livraison' } },
        { sourceFile: { contains: 'BON DE LIV' } },
        { sourceFile: { contains: 'bon de liv' } },
        { sourceFile: { contains: '\\\\BL\\\\' } },
        { sourceFile: { contains: '/BL/' } },
        { sourceFile: { contains: '\\\\bl\\\\' } },
        { sourceFile: { contains: '/bl/' } },
        { sourceFile: { contains: 'delivery note' } }
      ]
    } as Prisma.InvoiceWhereInput;
  }

  return undefined;
}

clientsRouter.get('/', async (req: Request, res: Response) => {
  const company = typeof req.query.company === 'string' ? req.query.company : undefined;
  const cacheKey = `clients:list:${company || 'all'}`;
  const clients = await cacheGetOrSet(cacheKey, 60_000, async () => {
    return prisma.client.findMany({
      where: company ? { company } : undefined,
      orderBy: { createdAt: 'desc' }
    });
  });
  res.json(clients);
});

/* ── Combined document metrics (all document types in one call) ── */
clientsRouter.get('/document-metrics', async (_req: Request, res: Response) => {
  const payload = await cacheGetOrSet('clients:document-metrics', 120_000, async () => {
    const docTypes: DocumentType[] = ['facture', 'devis', 'bon_de_livraison'];

    const results = await Promise.all(
      docTypes.map(async (dt) => {
        const invoiceWhere = documentTypeInvoiceWhere(dt);
        if (!invoiceWhere) return { type: dt, invoices: 0, totalAmount: 0, outstanding: 0 };

        const [grouped, unpaid] = await Promise.all([
          prisma.invoice.groupBy({
            by: ['clientId'],
            where: invoiceWhere,
            _count: { _all: true },
            _sum: { totalAmount: true },
          }),
          prisma.invoice.findMany({
            where: { AND: [invoiceWhere, { status: { not: 'paid' } }] },
            select: { totalAmount: true },
          }),
        ]);

        let invoices = 0;
        let totalAmount = 0;
        for (const g of grouped) {
          invoices += (g._count as { _all?: number })?._all ?? 0;
          totalAmount += Number((g._sum as { totalAmount?: number | null })?.totalAmount || 0);
        }

        let outstanding = 0;
        for (const inv of unpaid) outstanding += Number(inv.totalAmount || 0);

        return { type: dt, invoices, totalAmount, outstanding };
      }),
    );

    const metrics: Record<string, { invoices: number; totalAmount: number; outstanding: number }> = {};
    for (const r of results) metrics[r.type] = { invoices: r.invoices, totalAmount: r.totalAmount, outstanding: r.outstanding };
    return metrics;
  });

  res.json(payload);
});

clientsRouter.get('/summary', async (req: Request, res: Response) => {
  const cacheKey = `clients:summary:${req.originalUrl}`;
  const payload = await cacheGetOrSet(cacheKey, 60_000, async () => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const company = typeof req.query.company === 'string' ? req.query.company : undefined;
  const documentType = normalizeDocumentType(typeof req.query.documentType === 'string' ? req.query.documentType : undefined);
  const paginated = req.query.paginated === 'true' || typeof req.query.page === 'string' || typeof req.query.pageSize === 'string';
  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
  const pageSizeRaw = typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 200) : 30;

  const companyWhere =
    company === 'ACROBATE_SOLUTION'
      ? { OR: [{ company: 'ACROBATE_SOLUTION' }, { company: 'Acrobate Solution' }] }
      : company === 'GAMESTREAM_ATLAS'
        ? { OR: [{ company: 'GAMESTREAM_ATLAS' }, { company: 'GameStream ATLAS' }, { company: 'gamestream_atlas' }] }
        : {};

  const where = {
    ...companyWhere,
    ...(q
      ? {
          OR: [
            { name: { contains: q } },
            { email: { contains: q } },
            { phone: { contains: q } }
          ]
        }
      : {})
  };

  const [allClients, totalClients] = await Promise.all([
    prisma.client.findMany({
      where,
      select: { id: true, name: true, company: true, email: true, phone: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    }),
    paginated ? prisma.client.count({ where }) : Promise.resolve(0)
  ]);

  if (allClients.length === 0) {
    if (!paginated) return [];
    return { rows: [], total: totalClients, page, pageSize, totalPages: Math.max(1, Math.ceil(totalClients / pageSize)) };
  }

  const allClientIds = allClients.map((c) => c.id);

  // Sort clients by latest facture (invoice) activity first.
  const latestInvoicePerClient = await prisma.invoice.groupBy({
    by: ['clientId'],
    where: { clientId: { in: allClientIds } },
    _max: { createdAt: true }
  });

  const latestMap = new Map<string, Date>(
    latestInvoicePerClient
      .filter((entry) => Boolean(entry._max.createdAt))
      .map((entry) => [entry.clientId, entry._max.createdAt as Date])
  );

  const clientsSorted = [...allClients].sort((a, b) => {
    const aLatest = latestMap.get(a.id)?.getTime() ?? 0;
    const bLatest = latestMap.get(b.id)?.getTime() ?? 0;
    if (bLatest !== aLatest) return bLatest - aLatest;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const clients = paginated
    ? clientsSorted.slice((page - 1) * pageSize, page * pageSize)
    : clientsSorted;

  const clientIds = clients.map((c) => c.id);

  const invoiceCompanyWhere = companyInvoiceWhere(company);
  const invoiceDocumentTypeWhere = documentTypeInvoiceWhere(documentType);
  const invoiceAndFilters: Prisma.InvoiceWhereInput[] = [{ clientId: { in: clientIds } }];
  if (invoiceCompanyWhere) invoiceAndFilters.push(invoiceCompanyWhere);
  if (invoiceDocumentTypeWhere) invoiceAndFilters.push(invoiceDocumentTypeWhere);
  const invoiceWhere: Prisma.InvoiceWhereInput = invoiceAndFilters.length > 1
    ? { AND: invoiceAndFilters }
    : invoiceAndFilters[0];

  const [invoiceGrouped, unpaidInvoices] = await Promise.all([
    prisma.invoice.groupBy({
      by: ['clientId'],
      where: invoiceWhere,
      _count: { _all: true },
      _sum: { totalAmount: true }
    }),
    prisma.invoice.findMany({
      where: {
        AND: [
          invoiceWhere,
          { status: { not: 'paid' } }
        ]
      },
      select: { clientId: true, totalAmount: true }
    })
  ]);

  const groupedMap = new Map(
    invoiceGrouped.map((g) => {
      const invoiceCount = (g._count as { _all?: number } | undefined)?._all ?? 0;
      const totalBilled = Number((g._sum as { totalAmount?: number | null } | undefined)?.totalAmount || 0);
      return [g.clientId, { invoiceCount, totalBilled }] as const;
    })
  );

  const outstandingMap = new Map<string, number>();
  for (const inv of unpaidInvoices) {
    const key = inv.clientId;
    outstandingMap.set(key, (outstandingMap.get(key) || 0) + Number(inv.totalAmount || 0));
  }

  const rows = clients.map((client) => {
    const grouped = groupedMap.get(client.id);
    return {
      id: client.id,
      name: client.name,
      company: client.company,
      email: client.email,
      phone: client.phone,
      detectedCompany: detectCompany([client.company]),
      invoiceCount: grouped?.invoiceCount ?? 0,
      totalBilled: grouped?.totalBilled ?? 0,
      outstanding: outstandingMap.get(client.id) ?? 0
    };
  });

  if (!paginated) {
    return rows;
  }

  const totalPages = Math.max(1, Math.ceil(totalClients / pageSize));
  return { rows, total: totalClients, page, pageSize, totalPages };
  });

  return res.json(payload);
});

clientsRouter.get('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const includeItems = req.query.includeItems === 'true';
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const company = typeof req.query.company === 'string' ? req.query.company : undefined;
  const documentType = normalizeDocumentType(typeof req.query.documentType === 'string' ? req.query.documentType : undefined);

  if (!id) {
    return res.status(400).json({ message: 'Missing client id' });
  }

  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      invoices: {
        where: (() => {
          const filters: Prisma.InvoiceWhereInput[] = [];
          if (status) filters.push({ status });
          const companyWhere = companyInvoiceWhere(company);
          if (companyWhere) filters.push(companyWhere);
          const docWhere = documentTypeInvoiceWhere(documentType);
          if (docWhere) filters.push(docWhere);
          if (filters.length === 0) return undefined;
          return filters.length === 1 ? filters[0] : { AND: filters };
        })(),
        include: includeItems
          ? {
              items: {
                include: {
                  product: true
                }
              }
            }
          : undefined,
        orderBy: { date: 'desc' }
      }
    }
  });

  if (!client) {
    return res.status(404).json({ message: 'Client not found' });
  }

  res.json({
    ...client,
    invoices: client.invoices.map((invoice) => ({
      ...invoice,
      companyKey: detectCompany([invoice.companyName, invoice.sourceFile, client.company]),
      documentType: detectDocumentType([invoice.sourceFile, invoice.invoiceNo, invoice.notes])
    }))
  });
});

clientsRouter.post('/', async (req: Request, res: Response) => {
  const { name, company, email, phone } = req.body;
  const created = await prisma.client.create({
    data: { name, company, email, phone, tenantId: currentTenantId() }
  });
  cacheClear();
  res.status(201).json(created);
});

clientsRouter.put('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ message: 'Missing client id' });
  }
  const { name, company, email, phone } = req.body;

  const updated = await prisma.client.update({
    where: { id },
    data: {
      name,
      company,
      email,
      phone
    }
  });

  cacheClear();
  res.json(updated);
});

clientsRouter.delete('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ message: 'Missing client id' });
  }
  const invoiceCount = await prisma.invoice.count({ where: { clientId: id } });

  if (invoiceCount > 0) {
    return res.status(409).json({
      message: 'Cannot delete a client linked to invoices. Remove invoices first.'
    });
  }

  await prisma.client.delete({ where: { id } });
  cacheClear();
  return res.status(204).send();
});
