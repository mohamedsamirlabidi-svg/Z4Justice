/**
 * Twilio SMS channel (F2).
 *
 * In dry-run mode we log the intent but never touch the Twilio client, so
 * credentials aren't needed. Live mode requires TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in the environment.
 */
import type { ChannelContext, ChannelSendResult } from './types';

let cachedClient: unknown | null = null;

async function getClient() {
  if (cachedClient) return cachedClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  const twilio = await import('twilio');
  cachedClient = twilio.default(sid, token);
  return cachedClient;
}

export async function sendSms(ctx: ChannelContext): Promise<ChannelSendResult> {
  if (ctx.dryRun) {
    console.log(
      `[notif][dry-run][sms] to=${ctx.recipient} template=${ctx.templateKey} flag=${ctx.flagAtSend} body="${ctx.body.slice(0, 80).replace(/\n/g, ' ')}…"`,
    );
    return { status: 'skipped_dry_run' };
  }

  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) {
    return {
      status: 'failed',
      errorMessage: 'TWILIO_FROM_NUMBER not configured — required for live SMS',
    };
  }

  const client = await getClient();
  if (!client) {
    return {
      status: 'failed',
      errorMessage: 'Twilio client not initialized — set TWILIO_ACCOUNT_SID/AUTH_TOKEN',
    };
  }

  try {
    const message = await (
      client as { messages: { create: (opts: unknown) => Promise<{ sid: string }> } }
    ).messages.create({
      to: ctx.recipient,
      from,
      body: ctx.body,
    });
    return { status: 'sent', providerRef: message.sid };
  } catch (err) {
    return {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'Unknown Twilio error',
    };
  }
}
