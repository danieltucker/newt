import prisma from '../prisma';
import { openSecret } from './secretBox';
import { PROVIDERS, Provider, isProviderId } from './providers';
import { LlmError } from './chat';

/**
 * Getting from "this user wants to ask something" to "these are the parameters
 * of the call", in one place.
 *
 * Every AI route starts here, and this is the only module that ever calls
 * openSecret. That is deliberate: the decrypted key exists as a local for the
 * duration of one request and is never attached to a response object, a log
 * line, or a Prisma model that something else might serialize.
 */

export interface ResolvedCredential {
  id: string;
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * What the client is allowed to see about a stored key. Note what is missing:
 * the key. `keyLast4` is the whole of the disclosure.
 */
export function toPublicCredential(row: {
  id: string; provider: string; label: string; keyLast4: string;
  baseUrl: string; model: string; isDefault: boolean; createdAt: Date;
}) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    keyLast4: row.keyLast4,
    baseUrl: row.baseUrl,
    model: row.model,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The credential a request should use: the one named, or the user's default,
 * or — when they have exactly one key and never marked a default — that one.
 *
 * Throws LlmError rather than returning null so every caller reports the same
 * thing the same way. 400 rather than 404 across the board: from the client's
 * point of view these are all "you can't ask yet, here's why", and the message
 * is what the UI shows.
 */
export async function resolveCredential(userId: string, credentialId?: string | null): Promise<ResolvedCredential> {
  const rows = await prisma.llmCredential.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  if (rows.length === 0) {
    throw new LlmError('No AI model is connected. Add a key in Settings → AI to use this.', 400);
  }

  const row = credentialId
    ? rows.find(r => r.id === credentialId)
    : rows[0]; // isDefault first, oldest otherwise — see orderBy above

  if (!row) throw new LlmError('That model is no longer connected.', 400);
  if (!isProviderId(row.provider)) {
    throw new LlmError('That connection uses a provider this version no longer supports.', 400);
  }

  const provider = PROVIDERS[row.provider];

  // An empty ciphertext is what a keyless `compatible` endpoint stores, and is
  // a legitimate state — only try to decrypt when there is something there.
  let apiKey = '';
  if (row.keyCipher) {
    const opened = openSecret({ cipher: row.keyCipher, iv: row.keyIv, tag: row.keyTag });
    if (opened === null) {
      // The realistic cause is LLM_KEY_SECRET changing between deploys, which
      // makes every stored key undecryptable at once. Say so, because "invalid
      // key" would send the user to re-paste a key that was always fine.
      throw new LlmError(
        'That stored key could not be decrypted. If the server’s LLM_KEY_SECRET changed, ' +
        're-add the key in Settings → AI.',
        400,
      );
    }
    apiKey = opened;
  }

  if (provider.needsKey && !apiKey) {
    throw new LlmError(`${provider.label} needs an API key.`, 400);
  }
  if (!row.model) {
    throw new LlmError('That connection has no model set. Choose one in Settings → AI.', 400);
  }

  return { id: row.id, provider, apiKey, baseUrl: row.baseUrl, model: row.model };
}
