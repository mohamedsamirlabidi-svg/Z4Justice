/**
 * Notification channel types (F2).
 *
 * Adding a new channel:
 *   1. Add its key to `Channel` below.
 *   2. Add its implementation under `channels/<name>.ts`, exporting `send(ctx)`.
 *   3. Register in `notifications/engine.ts`.
 *
 * `whatsapp_voice` is reserved for a Twilio Voice + TTS integration that
 * places an automated call on the client's WhatsApp/phone. Not implemented
 * (blocked on user go-ahead + real Twilio Voice credentials).
 */
export type Channel = 'sms' | 'email' | 'whatsapp' | 'whatsapp_voice' | 'legal_letter';

export type ChannelSendResult =
  | { status: 'sent'; providerRef?: string }
  | { status: 'skipped_dry_run' }
  | { status: 'skipped_dedup'; reason: string }
  | { status: 'failed'; errorMessage: string };

export type ChannelContext = {
  invoiceId: string;
  clientId: string | null;
  recipient: string; // phone / email / whatsapp id
  subject?: string;
  body: string;
  templateKey: string;
  flagAtSend: string;
  dryRun: boolean;
};
