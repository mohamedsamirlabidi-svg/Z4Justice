/**
 * Per-tenant API key minting and verification (F6.4).
 *
 * Keys look like:  erm_live_<32-hex-chars>
 *   - `erm_live_`  human-visible prefix
 *   - 32 hex chars from crypto.randomBytes(16)  → 128 bits of entropy
 *
 * We store SHA-256(keyPlain) as `keyHash`. That's fast enough for per-request
 * lookups (single hash) and safe because the key has enough entropy that no
 * offline brute force is feasible. We do NOT use bcrypt here — bcrypt is for
 * low-entropy secrets (passwords); an API key is a high-entropy secret.
 *
 * The plaintext key is returned to the caller ONCE at mint time and never
 * again. Only the prefix (first 12 chars) is retained for identification in
 * the UI.
 */

import crypto from 'node:crypto';

export const KEY_PLAIN_PREFIX = 'erm_live_';
export const KEY_PREFIX_LENGTH = 12;

export function mintApiKeyPlain(): string {
  return `${KEY_PLAIN_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

export function hashApiKey(plain: string): string {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

export function prefixFor(plain: string): string {
  return plain.slice(0, KEY_PREFIX_LENGTH);
}

/**
 * Extract the plaintext key from a request. Accepts either
 * `Authorization: Bearer <key>` or `x-api-key: <key>`.
 * Returns null if no key was provided.
 */
export function extractApiKeyFromHeaders(headers: {
  authorization?: string | string[];
  'x-api-key'?: string | string[];
}): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const candidate = auth.slice(7).trim();
    if (candidate.startsWith(KEY_PLAIN_PREFIX)) {
      return candidate;
    }
  }
  const xApi = headers['x-api-key'];
  if (typeof xApi === 'string' && xApi.trim()) {
    return xApi.trim();
  }
  return null;
}
