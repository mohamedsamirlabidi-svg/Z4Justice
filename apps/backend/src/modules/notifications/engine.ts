/**
 * Notification engine (F2).
 *
 * Dispatch rules (from F2 spec):
 *   yellow  → SMS + Email
 *   orange  → SMS + Email + WhatsApp
 *   red     → SMS + Email + WhatsApp   (this is the "1 warning before mise en demeure")
 *   others  → no-op
 *
 * Idempotency: we consult NotificationLog before firing. If we've already sent
 * (or dry-run-logged) this invoice + channel + flag color, we skip and record
 * a `status: 'skipped_dedup'` entry. This means the flag worker can re-run
 * hourly without re-notifying the same client.
 *
 * Dry-run: NOTIFICATIONS_DRY_RUN defaults to 'true' — the code path exists
 * but no real SMS/Email/WhatsApp goes out until you flip the env flag AND
 * provide credentials.
 */
import { prisma } from '../../prisma';
import { renderTemplate, TEMPLATES, templateForFlag, type InvoiceForNotify } from './templates';
import type { Channel, ChannelContext, ChannelSendResult } from './channels/types';
import { sendSms } from './channels/sms-twilio';
import { sendEmail } from './channels/email-smtp';
import { sendWhatsApp } from './channels/whatsapp-chatwoot';

const CHANNELS_BY_FLAG: Record<string, Channel[]> = {
  yellow: ['sms', 'email'],
  orange: ['sms', 'email', 'whatsapp'],
  red: ['sms', 'email', 'whatsapp'],
};

function isDryRun(): boolean {
  return (process.env.NOTIFICATIONS_DRY_RUN ?? 'true').toLowerCase() !== 'false';
}

type InvoiceForEngine = {
  id: string;
  tenantId: string;
  invoiceNo: string;
  totalAmount: number;
  currency: string;
  dueDate: Date | null;
  companyName: string | null;
  client: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  } | null;
};

function formatAmount(amount: number, currency: string): string {
  return `${amount.toFixed(3).replace(/\.?0+$/, '')} ${currency}`;
}

function daysBetween(now: Date, due: Date): number {
  const MS = 86_400_000;
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  return Math.max(0, Math.floor((a - b) / MS));
}

function buildRenderCtx(invoice: InvoiceForEngine, now: Date): InvoiceForNotify {
  return {
    invoiceNo: invoice.invoiceNo,
    amountFormatted: formatAmount(invoice.totalAmount, invoice.currency || 'TND'),
    dueDateFormatted: invoice.dueDate
      ? invoice.dueDate.toLocaleDateString('fr-TN')
      : 'non défini',
    daysOverdue: invoice.dueDate ? daysBetween(now, invoice.dueDate) : 0,
    clientName: invoice.client?.name ?? 'Client',
    companyName: invoice.companyName ?? 'Notre société',
  };
}

async function alreadySentForFlag(
  invoiceId: string,
  channel: Channel,
  flag: string,
): Promise<boolean> {
  const existing = await prisma.notificationLog.findFirst({
    where: {
      invoiceId,
      channel,
      flagAtSend: flag,
      status: { in: ['sent', 'skipped_dry_run'] },
    },
    select: { id: true },
  });
  return existing !== null;
}

async function recordAttempt(params: {
  invoiceId: string;
  tenantId: string;
  clientId: string | null;
  channel: Channel;
  recipient: string;
  flagAtSend: string;
  templateKey: string;
  contentPreview: string;
  result: ChannelSendResult;
}): Promise<void> {
  const { invoiceId, tenantId, clientId, channel, recipient, flagAtSend, templateKey, contentPreview, result } = params;
  await prisma.notificationLog.create({
    data: {
      tenantId,
      invoiceId,
      clientId: clientId ?? undefined,
      channel,
      recipient,
      status: result.status,
      errorMessage: result.status === 'failed' ? result.errorMessage : result.status === 'skipped_dedup' ? result.reason : null,
      templateKey,
      flagAtSend,
      contentPreview: contentPreview.slice(0, 400),
    },
  });
}

const SENDERS: Record<Channel, (ctx: ChannelContext) => Promise<ChannelSendResult>> = {
  sms: sendSms,
  email: sendEmail,
  whatsapp: sendWhatsApp,
  whatsapp_voice: async () => ({ status: 'failed', errorMessage: 'whatsapp_voice deferred' }),
  legal_letter: async () => ({ status: 'failed', errorMessage: 'legal_letter handled by F3 legal module' }),
};

/**
 * Dispatch notifications for a single invoice at a given flag color.
 * Idempotent per (invoice, channel, flag) via NotificationLog dedup.
 */
export async function dispatchForInvoiceFlag(params: {
  invoice: InvoiceForEngine;
  flag: string;
  now?: Date;
}): Promise<{ attempts: Array<{ channel: Channel; status: string }> }> {
  const { invoice, flag } = params;
  const now = params.now ?? new Date();
  const dryRun = isDryRun();

  const channels = CHANNELS_BY_FLAG[flag];
  if (!channels || channels.length === 0) {
    return { attempts: [] };
  }

  const templateKey = templateForFlag(flag);
  if (!templateKey) {
    return { attempts: [] };
  }
  const template = TEMPLATES[templateKey];
  const rendered = renderTemplate(template, buildRenderCtx(invoice, now));

  const attempts: Array<{ channel: Channel; status: string }> = [];

  for (const channel of channels) {
    // Deduplicate: skip if we already fired this exact (invoice, channel, flag).
    if (await alreadySentForFlag(invoice.id, channel, flag)) {
      await recordAttempt({
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        clientId: invoice.client?.id ?? null,
        channel,
        recipient: '(dedup)',
        flagAtSend: flag,
        templateKey,
        contentPreview: '(previous send exists)',
        result: { status: 'skipped_dedup', reason: 'already-sent-for-this-flag' },
      });
      attempts.push({ channel, status: 'skipped_dedup' });
      continue;
    }

    const recipient = pickRecipient(channel, invoice);
    if (!recipient) {
      await recordAttempt({
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        clientId: invoice.client?.id ?? null,
        channel,
        recipient: '(missing)',
        flagAtSend: flag,
        templateKey,
        contentPreview: rendered.body,
        result: { status: 'failed', errorMessage: `No ${channel} recipient on client record` },
      });
      attempts.push({ channel, status: 'failed' });
      continue;
    }

    const ctx: ChannelContext = {
      invoiceId: invoice.id,
      clientId: invoice.client?.id ?? null,
      recipient,
      subject: rendered.subject,
      body: rendered.body,
      templateKey,
      flagAtSend: flag,
      dryRun,
    };

    const result = await SENDERS[channel](ctx);

    await recordAttempt({
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      clientId: invoice.client?.id ?? null,
      channel,
      recipient,
      flagAtSend: flag,
      templateKey,
      contentPreview: rendered.body,
      result,
    });
    attempts.push({ channel, status: result.status });
  }

  // Stamp lastNotifiedAt so downstream (F3 escalation worker) can gate on it.
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { lastNotifiedAt: now },
  });

  return { attempts };
}

function pickRecipient(channel: Channel, invoice: InvoiceForEngine): string | null {
  const c = invoice.client;
  if (!c) return null;
  switch (channel) {
    case 'sms':
      return c.phone ?? null;
    case 'email':
      return c.email ?? null;
    case 'whatsapp':
      // TODO(F5): use client.whatsappNumber once we add that field. Fallback to phone for now.
      return c.phone ?? null;
    default:
      return null;
  }
}

