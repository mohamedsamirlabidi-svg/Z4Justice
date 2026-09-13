import { Request, Response, Router } from 'express';
import { prisma } from '../../prisma';
import { cacheClear, cacheGetOrSet } from '../../cache';
import { currentTenantId } from '../../tenant-context';
import { authMiddleware, requireRole } from '../auth/middleware';

export const invoicesRouter = Router();

// F6.2: every route on this router requires an authenticated tenant user.
// PUT /:id still uses `requireRole('admin')` on top for admin-only edits.
invoicesRouter.use(authMiddleware);

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

function getCompanyPaymentDefaults(company: CompanyKey) {
  if (company === 'ACROBATE_SOLUTION') {
    return {
      bank: 'STB THAMEUR',
      rib: '10 000 000 080746 3788 95'
    };
  }

  return {
    bank: null,
    rib: null
  };
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

type InvoiceItemInput = {
  productId: string;
  quantity: number | string;
  unitPrice: number | string;
};

type IncomingNestedClient = {
  name?: string;
  address?: string;
  city?: string;
  taxId?: string;
  contactName?: string;
  country?: string;
  phone?: string;
  email?: string;
};

type IncomingNestedItem = {
  productId?: string;
  productCode?: string;
  ref?: string;
  sku?: string;
  description?: string;
  qty?: number | string;
  quantity?: number | string;
  unitPrice?: number | string;
  amount?: number | string;
  totalPrice?: number | string;
};

type IncomingMetadata = Record<string, unknown>;

function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') {
    return null;
  }
  return trimmed;
}

function getMetaValue(metadata: IncomingMetadata | undefined, key: string): unknown {
  return metadata ? metadata[key] : undefined;
}

function toTaxRate(value: unknown, fallback = 0): number {
  if (typeof value === 'string' && value.includes('%')) {
    const parsed = Number(value.replace('%', '').trim());
    if (Number.isFinite(parsed)) {
      return parsed / 100;
    }
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed > 1 ? parsed / 100 : parsed;
}

async function ensureClientForInvoice(client: IncomingNestedClient | undefined, company?: string) {
  const name = (client?.name ?? '').trim() || 'Unknown';

  const existing = await prisma.client.findFirst({
    where: {
      name,
      ...(company ? { company } : {})
    }
  });

  if (existing) {
    return existing;
  }

  return prisma.client.create({
    data: {
      name,
      company,
      email: client?.email,
      phone: client?.phone,
      tenantId: currentTenantId()
    }
  });
}

async function ensureProductForInvoice(item: IncomingNestedItem) {
  const sku = (item.productCode ?? item.ref ?? item.sku ?? '').trim() || undefined;
  const name = (item.description ?? item.productCode ?? item.ref ?? item.sku ?? 'Unknown Item').trim();
  const unitPrice = toNumber(item.unitPrice, 0);

  if (sku) {
    const bySku = await prisma.product.findFirst({ where: { sku } });
    if (bySku) {
      return bySku;
    }
  }

  const byName = await prisma.product.findFirst({ where: { name } });
  if (byName) {
    return byName;
  }

  return prisma.product.create({
    data: {
      name,
      sku,
      unitPrice,
      tenantId: currentTenantId()
    }
  });
}

invoicesRouter.get('/summary', async (_req: Request, res: Response) => {
  const cacheKey = `invoices:summary:${_req.originalUrl}`;
  const payload = await cacheGetOrSet(cacheKey, 120_000, async () => {
  const invoices = await prisma.invoice.findMany({
    select: {
      totalAmount: true,
      clientId: true,
      companyName: true,
      sourceFile: true,
      client: {
        select: {
          company: true
        }
      }
    }
  });

  const clients = await prisma.client.findMany({
    select: {
      id: true,
      company: true
    }
  });

  const stats: Record<'ACROBATE_SOLUTION' | 'GAMESTREAM_ATLAS', { clients: Set<string>; invoices: number; revenue: number }> = {
    ACROBATE_SOLUTION: { clients: new Set<string>(), invoices: 0, revenue: 0 },
    GAMESTREAM_ATLAS: { clients: new Set<string>(), invoices: 0, revenue: 0 }
  };

  for (const client of clients) {
    const company = detectCompany([client.company]);
    if (company === 'UNKNOWN') continue;
    stats[company].clients.add(client.id);
  }

  for (const invoice of invoices) {
    const company = detectCompany([
      invoice.client?.company,
      invoice.companyName,
      invoice.sourceFile
    ]);

    if (company === 'UNKNOWN') continue;

    stats[company].invoices += 1;
    stats[company].revenue += Number(invoice.totalAmount || 0);
    if (invoice.clientId) stats[company].clients.add(invoice.clientId);
  }

  return {
    companies: {
      ACROBATE_SOLUTION: {
        clients: stats.ACROBATE_SOLUTION.clients.size,
        invoices: stats.ACROBATE_SOLUTION.invoices,
        revenue: stats.ACROBATE_SOLUTION.revenue
      },
      GAMESTREAM_ATLAS: {
        clients: stats.GAMESTREAM_ATLAS.clients.size,
        invoices: stats.GAMESTREAM_ATLAS.invoices,
        revenue: stats.GAMESTREAM_ATLAS.revenue
      }
    }
  };
  });

  return res.json(payload);
});

invoicesRouter.get('/', async (_req: Request, res: Response) => {
  const cacheKey = `invoices:list:${_req.originalUrl}`;
  const payload = await cacheGetOrSet(cacheKey, 60_000, async () => {
  const req = _req;
  const company = typeof req.query.company === 'string' ? req.query.company : undefined;
  const documentType = normalizeDocumentType(typeof req.query.documentType === 'string' ? req.query.documentType : undefined);
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const includeItems = req.query.includeItems === 'true';
  const paginated = req.query.paginated === 'true' || typeof req.query.page === 'string' || typeof req.query.pageSize === 'string';
  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
  const pageSizeRaw = typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 200) : 30;

  const companyWhere: Record<string, unknown> | undefined =
    company === 'ACROBATE_SOLUTION'
      ? {
          OR: [
            { client: { company: 'ACROBATE_SOLUTION' } },
            { client: { company: 'Acrobate Solution' } },
            { companyName: { contains: 'acrobate' } },
            { sourceFile: { contains: 'ACROBATE' } }
          ]
        }
      : company === 'GAMESTREAM_ATLAS'
        ? {
            OR: [
              { client: { company: 'GAMESTREAM_ATLAS' } },
              { client: { company: 'GameStream ATLAS' } },
              { companyName: { contains: 'gamestream' } },
              { companyName: { contains: 'atlas' } },
              { sourceFile: { contains: 'GAMESTREAM' } },
              { sourceFile: { contains: 'GameStream' } }
            ]
          }
        : undefined;

  const documentTypeWhere: Record<string, unknown> | undefined =
    documentType === 'devis'
      ? {
          OR: [
            { sourceFile: { contains: 'devis' } },
            { sourceFile: { contains: 'DEVIS' } },
            { sourceFile: { contains: 'offre' } },
            { sourceFile: { contains: 'quotation' } },
            { sourceFile: { contains: 'quote' } },
            { invoiceNo: { contains: 'DEVIS' } }
          ]
        }
      : documentType === 'facture'
        ? {
            OR: [
              { sourceFile: { contains: 'facture' } },
              { sourceFile: { contains: 'FACTURE' } },
              { sourceFile: { contains: 'invoice' } },
              { invoiceNo: { contains: 'FAC' } },
              { invoiceNo: { contains: 'FACT' } }
            ]
          }
        : documentType === 'bon_de_livraison'
          ? {
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
            }
        : undefined;

  const searchWhere: Record<string, unknown> | undefined = q
    ? {
        OR: [
          { invoiceNo: { contains: q } },
          { companyName: { contains: q } },
          { client: { name: { contains: q } } }
        ]
      }
    : undefined;

  const andFilters = [
    clientId ? { clientId } : undefined,
    status ? { status } : undefined,
    companyWhere,
    documentTypeWhere,
    searchWhere
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry));

  const where = andFilters.length > 0 ? { AND: andFilters } : {};

  const invoices = await prisma.invoice.findMany({
    where,
    include: includeItems
      ? {
          client: true,
          items: { include: { product: true } }
        }
      : {
          client: true
        },
    orderBy: { createdAt: 'desc' },
    ...(paginated
      ? {
          skip: (page - 1) * pageSize,
          take: pageSize
        }
      : {})
  });

  const normalizedInvoices = invoices.map((invoice) => ({
    ...invoice,
    companyKey: detectCompany([invoice.client?.company, invoice.companyName, invoice.sourceFile]),
    documentType: detectDocumentType([invoice.sourceFile, invoice.invoiceNo, invoice.notes])
  }));

  if (!paginated) {
    return normalizedInvoices;
  }

  const total = await prisma.invoice.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    rows: normalizedInvoices,
    total,
    page,
    pageSize,
    totalPages
  };
  });

  return res.json(payload);
});

invoicesRouter.get('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!id) {
    return res.status(400).json({ message: 'Missing invoice id' });
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      items: { include: { product: true } }
    }
  });

  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found' });
  }

  res.json({
    ...invoice,
    companyKey: detectCompany([invoice.client?.company, invoice.companyName, invoice.sourceFile]),
    documentType: detectDocumentType([invoice.sourceFile, invoice.invoiceNo, invoice.notes])
  });
});

invoicesRouter.post('/', async (req: Request, res: Response) => {
  const {
    company,
    client,
    items,
    metadata,
    invoiceNo,
    date,
    dueDate,
    status,
    clientId,
    currency,
    totalAmount,
    totalHT,
    taxRate,
    taxAmount,
    companyName,
    companyEmail,
    companyPhone,
    paymentTerms,
    sellerAddress,
    sellerWebsite,
    rib,
    bank,
    consultationRef,
    responsable,
    contactName,
    amountInWords,
    timbreFiscal,
    orderNo,
    sourceFile,
    notes
  } = req.body;

  const metadataObj = metadata && typeof metadata === 'object' ? (metadata as IncomingMetadata) : undefined;

  const normalizedItemsInput = Array.isArray(items) ? (items as IncomingNestedItem[]) : [];

  const normalizedItems = await Promise.all(
    normalizedItemsInput.map(async (item) => {
      const product = item.productId
        ? await prisma.product.findUnique({ where: { id: item.productId } })
        : await ensureProductForInvoice(item);

      const ensuredProduct = product ?? (await ensureProductForInvoice(item));
      const quantity = toNumber(item.quantity ?? item.qty, 1) || 1;
      const unitPrice = toNumber(item.unitPrice, ensuredProduct.unitPrice ?? 0);
      const lineTotal = toNumber(item.totalPrice ?? item.amount, quantity * unitPrice);

      return {
        productId: ensuredProduct.id,
        description: item.description,
        quantity,
        unitPrice,
        lineTotal
      };
    })
  );

  const computedTotal = normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const persistedTotal = toNumber(totalAmount, computedTotal);

  const resolvedClient = clientId
    ? await prisma.client.findUnique({ where: { id: clientId } })
    : await ensureClientForInvoice(client as IncomingNestedClient | undefined, typeof company === 'string' ? company : undefined);

  if (!resolvedClient) {
    return res.status(400).json({ message: 'Unable to resolve client for invoice payload' });
  }

  const metadataString = metadata ? JSON.stringify(metadata) : '';
  const mergedNotes = [notes, metadataString].filter((v) => typeof v === 'string' && v.trim().length > 0).join(' | ');
  const normalizedInvoiceNo = typeof invoiceNo === 'string' && invoiceNo.trim().length > 0
    ? invoiceNo.trim()
    : `AUTO-${Date.now()}`;

  const resolvedCompanyName = toOptionalString(companyName) ?? toOptionalString(getMetaValue(metadataObj, 'sellerName'));
  const resolvedCompanyEmail = toOptionalString(companyEmail) ?? toOptionalString(getMetaValue(metadataObj, 'sellerEmail'));
  const resolvedCompanyPhone = toOptionalString(companyPhone) ?? toOptionalString(getMetaValue(metadataObj, 'companyPhone'));
  const resolvedPaymentTerms = toOptionalString(paymentTerms) ?? toOptionalString(getMetaValue(metadataObj, 'consultationRef'));

  const resolvedSellerAddress = toOptionalString(sellerAddress) ?? toOptionalString(getMetaValue(metadataObj, 'sellerAddress'));
  const resolvedSellerWebsite = toOptionalString(sellerWebsite) ?? toOptionalString(getMetaValue(metadataObj, 'sellerWebsite'));
  const resolvedConsultationRef = toOptionalString(consultationRef) ?? toOptionalString(getMetaValue(metadataObj, 'consultationRef'));
  const resolvedResponsable =
    toOptionalString(responsable) ??
    toOptionalString(contactName) ??
    toOptionalString((client as IncomingNestedClient | undefined)?.contactName) ??
    toOptionalString(getMetaValue(metadataObj, 'responsable'));
  const resolvedAmountInWords = toOptionalString(amountInWords) ?? toOptionalString(getMetaValue(metadataObj, 'amountInWords'));

  const companyKey = detectCompany([
    typeof company === 'string' ? company : undefined,
    resolvedCompanyName,
    resolvedClient.company,
    resolvedClient.name
  ]);
  const paymentDefaults = getCompanyPaymentDefaults(companyKey);
  const resolvedRib =
    toOptionalString(rib) ??
    toOptionalString(getMetaValue(metadataObj, 'rib')) ??
    paymentDefaults.rib;
  const resolvedBank =
    toOptionalString(bank) ??
    toOptionalString(getMetaValue(metadataObj, 'bank')) ??
    paymentDefaults.bank;

  const resolvedTotalHT = toNumber(totalHT ?? getMetaValue(metadataObj, 'totalHT'), computedTotal) || computedTotal;
  const resolvedTaxRate = toTaxRate(taxRate ?? getMetaValue(metadataObj, 'tvaRate'), 0.19);
  const resolvedTaxAmount = toNumber(taxAmount ?? getMetaValue(metadataObj, 'tvaAmount'), resolvedTotalHT * resolvedTaxRate);
  const resolvedTimbreFiscal = toNumber(timbreFiscal ?? getMetaValue(metadataObj, 'timbreFiscal'), 0.6);
  const resolvedOrderNo = toOptionalString(orderNo) ?? toOptionalString(getMetaValue(metadataObj, 'orderNo'));

  const tenantId = currentTenantId();
  const upserted = await prisma.invoice.upsert({
    where: { tenantId_invoiceNo: { tenantId, invoiceNo: normalizedInvoiceNo } },
    create: {
      invoiceNo: normalizedInvoiceNo,
      date: date ? new Date(date) : new Date(),
      dueDate: dueDate ? new Date(dueDate) : null,
      status: status ?? 'draft',
      clientId: resolvedClient.id,
      currency: typeof currency === 'string' ? currency : 'TND',
      totalAmount: persistedTotal,
      taxRate: resolvedTaxRate,
      taxAmount: resolvedTaxAmount,
      companyName: resolvedCompanyName,
      companyEmail: resolvedCompanyEmail,
      companyPhone: resolvedCompanyPhone,
      paymentTerms: resolvedPaymentTerms,
      sellerAddress: resolvedSellerAddress,
      sellerWebsite: resolvedSellerWebsite,
      rib: resolvedRib,
      bank: resolvedBank,
      consultationRef: resolvedConsultationRef,
      responsable: resolvedResponsable,
      contactName: resolvedResponsable,
      amountInWords: resolvedAmountInWords,
      timbreFiscal: resolvedTimbreFiscal,
      totalHT: resolvedTotalHT,
      orderNo: resolvedOrderNo,
      sourceFile: typeof sourceFile === 'string' ? sourceFile : undefined,
      notes: mergedNotes || undefined,
      tenantId
    },
    update: {
      date: date ? new Date(date) : undefined,
      dueDate: dueDate ? new Date(dueDate) : null,
      status: status ?? undefined,
      clientId: resolvedClient.id,
      currency: typeof currency === 'string' ? currency : undefined,
      totalAmount: persistedTotal,
      taxRate: resolvedTaxRate,
      taxAmount: resolvedTaxAmount,
      companyName: resolvedCompanyName,
      companyEmail: resolvedCompanyEmail,
      companyPhone: resolvedCompanyPhone,
      paymentTerms: resolvedPaymentTerms,
      sellerAddress: resolvedSellerAddress,
      sellerWebsite: resolvedSellerWebsite,
      rib: resolvedRib,
      bank: resolvedBank,
      consultationRef: resolvedConsultationRef,
      responsable: resolvedResponsable,
      contactName: resolvedResponsable,
      amountInWords: resolvedAmountInWords,
      timbreFiscal: resolvedTimbreFiscal,
      totalHT: resolvedTotalHT,
      orderNo: resolvedOrderNo,
      sourceFile: typeof sourceFile === 'string' ? sourceFile : undefined,
      notes: mergedNotes || undefined
    }
  });

  await prisma.invoiceItem.deleteMany({ where: { invoiceId: upserted.id } });
  if (normalizedItems.length > 0) {
    await prisma.invoiceItem.createMany({
      data: normalizedItems.map((item) => ({
        invoiceId: upserted.id,
        productId: item.productId,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
        tenantId
      }))
    });
  }

  const result = await prisma.invoice.findUnique({
    where: { id: upserted.id },
    include: {
      client: true,
      items: { include: { product: true } }
    }
  });

  cacheClear();
  return res.status(201).json(result);
});

invoicesRouter.put('/:id', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ message: 'Missing invoice id' });
  }
  const {
    invoiceNo,
    date,
    dueDate,
    status,
    verified,
    currency,
    totalAmount,
    totalHT,
    taxRate,
    taxAmount,
    timbreFiscal,
    orderNo,
    companyName,
    companyEmail,
    companyPhone,
    paymentTerms,
    sellerAddress,
    sellerWebsite,
    rib,
    bank,
    consultationRef,
    responsable,
    contactName,
    amountInWords,
    notes,
    sourceFile,
    items,
    client
  } = req.body;

  const updateData: Record<string, unknown> = {};

  if (invoiceNo !== undefined) updateData.invoiceNo = toOptionalString(invoiceNo);
  if (date !== undefined) updateData.date = date ? new Date(date) : undefined;
  if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
  if (status !== undefined) {
    const normalizedStatus = toOptionalString(status);
    updateData.status = normalizedStatus;
    if (verified === undefined && normalizedStatus?.toLowerCase() === 'verified') {
      updateData.verified = true;
    }
  }
  if (verified !== undefined) {
    if (typeof verified === 'boolean') {
      updateData.verified = verified;
    } else if (typeof verified === 'string') {
      updateData.verified = verified.trim().toLowerCase() === 'true';
    }
  }

  if (currency !== undefined) updateData.currency = toOptionalString(currency);
  if (totalAmount !== undefined) updateData.totalAmount = toNumber(totalAmount);
  if (totalHT !== undefined) updateData.totalHT = toNumber(totalHT);
  if (taxRate !== undefined) updateData.taxRate = toTaxRate(taxRate);
  if (taxAmount !== undefined) updateData.taxAmount = toNumber(taxAmount);
  if (timbreFiscal !== undefined) updateData.timbreFiscal = toNumber(timbreFiscal);
  if (orderNo !== undefined) updateData.orderNo = toOptionalString(orderNo);

  if (companyName !== undefined) updateData.companyName = toOptionalString(companyName);
  if (companyEmail !== undefined) updateData.companyEmail = toOptionalString(companyEmail);
  if (companyPhone !== undefined) updateData.companyPhone = toOptionalString(companyPhone);
  if (paymentTerms !== undefined) updateData.paymentTerms = toNullableString(paymentTerms);
  if (sellerAddress !== undefined) updateData.sellerAddress = toOptionalString(sellerAddress);
  if (sellerWebsite !== undefined) updateData.sellerWebsite = toOptionalString(sellerWebsite);
  if (rib !== undefined) updateData.rib = toOptionalString(rib);
  if (bank !== undefined) updateData.bank = toOptionalString(bank);
  if (consultationRef !== undefined) updateData.consultationRef = toOptionalString(consultationRef);
  if (responsable !== undefined) updateData.responsable = toOptionalString(responsable);
  if (amountInWords !== undefined) updateData.amountInWords = toOptionalString(amountInWords);
  if (notes !== undefined) updateData.notes = toOptionalString(notes);
  if (sourceFile !== undefined) updateData.sourceFile = toOptionalString(sourceFile);

  if (contactName !== undefined) {
    const normalizedContact = toOptionalString(contactName);
    updateData.contactName = normalizedContact;
    updateData.responsable = normalizedContact;
  }

  const normalizedItemsInput = Array.isArray(items) ? (items as IncomingNestedItem[]) : undefined;

  let normalizedItems: Array<{
    productId: string;
    description?: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }> | undefined;

  if (normalizedItemsInput) {
    normalizedItems = await Promise.all(
      normalizedItemsInput.map(async (item) => {
        const product = item.productId
          ? await prisma.product.findUnique({ where: { id: item.productId } })
          : await ensureProductForInvoice(item);

        const ensuredProduct = product ?? (await ensureProductForInvoice(item));
        const quantity = toNumber(item.quantity ?? item.qty, 1) || 1;
        const unitPrice = toNumber(item.unitPrice, ensuredProduct.unitPrice ?? 0);
        const lineTotal = toNumber(item.totalPrice ?? item.amount, quantity * unitPrice);

        return {
          productId: ensuredProduct.id,
          description: toOptionalString(item.description),
          quantity,
          unitPrice,
          lineTotal
        };
      })
    );

    const computedTotal = normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0);
    if (totalAmount === undefined) {
      updateData.totalAmount = computedTotal;
    }
    if (totalHT === undefined) {
      updateData.totalHT = computedTotal;
    }
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: updateData,
    include: {
      client: true,
      items: { include: { product: true } }
    }
  });

  if (normalizedItemsInput) {
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: id } });
    if (normalizedItems && normalizedItems.length > 0) {
      const itemTenantId = currentTenantId();
      await prisma.invoiceItem.createMany({
        data: normalizedItems.map((item) => ({
          invoiceId: id,
          productId: item.productId,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          tenantId: itemTenantId
        }))
      });
    }
  }

  const incomingClient = client && typeof client === 'object' ? (client as IncomingNestedClient) : undefined;
  if (incomingClient) {
    const clientData: Record<string, unknown> = {};
    const nextClientName = toOptionalString(incomingClient.name);
    if (nextClientName) clientData.name = nextClientName;
    if (incomingClient.phone !== undefined) clientData.phone = toNullableString(incomingClient.phone);
    if (incomingClient.email !== undefined) clientData.email = toNullableString(incomingClient.email);

    if (Object.keys(clientData).length > 0) {
      await prisma.client.update({
        where: { id: updated.clientId },
        data: clientData
      });
    }
  }

  const result = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      items: { include: { product: true } }
    }
  });

  cacheClear();
  res.json(result ?? updated);
});

invoicesRouter.delete('/:id', async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ message: 'Missing invoice id' });
  }

  await prisma.invoiceItem.deleteMany({ where: { invoiceId: id } });
  await prisma.invoice.delete({ where: { id } });
  cacheClear();
  return res.status(204).send();
});
