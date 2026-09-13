/**
 * Gmail SMTP email channel (F2).
 *
 * In dry-run mode we log the intent but never touch nodemailer, so credentials
 * aren't needed. Live mode requires GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD
 * (Gmail App Password, NOT the raw account password).
 */
import type { Transporter } from 'nodemailer';
import type { ChannelContext, ChannelSendResult } from './types';

let cachedTransporter: Transporter | null = null;

async function getTransporter(): Promise<Transporter | null> {
  if (cachedTransporter) return cachedTransporter;
  const user = process.env.GMAIL_SMTP_USER;
  const pass = process.env.GMAIL_SMTP_APP_PASSWORD;
  if (!user || !pass) return null;
  const nodemailer = await import('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return cachedTransporter;
}

export async function sendEmail(ctx: ChannelContext): Promise<ChannelSendResult> {
  if (ctx.dryRun) {
    console.log(
      `[notif][dry-run][email] to=${ctx.recipient} subject="${ctx.subject ?? ''}" template=${ctx.templateKey} flag=${ctx.flagAtSend}`,
    );
    return { status: 'skipped_dry_run' };
  }

  const transporter = await getTransporter();
  if (!transporter) {
    return {
      status: 'failed',
      errorMessage:
        'SMTP transporter not initialized — set GMAIL_SMTP_USER / GMAIL_SMTP_APP_PASSWORD',
    };
  }

  const from = process.env.GMAIL_SMTP_USER!;
  try {
    const info = await transporter.sendMail({
      from,
      to: ctx.recipient,
      subject: ctx.subject ?? 'Notification',
      text: ctx.body,
    });
    return { status: 'sent', providerRef: info.messageId };
  } catch (err) {
    return {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'Unknown SMTP error',
    };
  }
}
