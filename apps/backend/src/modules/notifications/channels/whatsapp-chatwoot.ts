/**
 * WhatsApp via Chatwoot (F2 — STUB).
 *
 * Deferred implementation: Chatwoot's outbound-conversation API requires
 * research + real CHATWOOT_BASE_URL / API_ACCESS_TOKEN / ACCOUNT_ID /
 * INBOX_ID to test. The engine treats this channel identically to SMS/email
 * once implemented — we log in dry-run today and stop.
 *
 * Blocking on: user-provided Chatwoot instance URL + API token.
 */
import type { ChannelContext, ChannelSendResult } from './types';

export async function sendWhatsApp(ctx: ChannelContext): Promise<ChannelSendResult> {
  if (ctx.dryRun) {
    console.log(
      `[notif][dry-run][whatsapp] to=${ctx.recipient} template=${ctx.templateKey} flag=${ctx.flagAtSend}`,
    );
    return { status: 'skipped_dry_run' };
  }
  return {
    status: 'failed',
    errorMessage: 'WhatsApp via Chatwoot not implemented — awaiting credentials + design go-ahead',
  };
}
