import nodeFetch from 'node-fetch';
import type { Response } from 'node-fetch';
import type { Readable } from 'stream';
import { resolveSafeAgent } from './isSafeUrl';

/**
 * An outbound fetch to a user-supplied address, with the SSRF gate applied to
 * every hop.
 *
 * `makeSafeAgent` on its own only guards the address you hand it. Two things get
 * past that if the fetch is left to follow redirects itself:
 *
 *  - **The redirect.** A site anyone can subscribe to answers 302 to
 *    `http://169.254.169.254/latest/meta-data/`, and node-fetch follows it - with
 *    the agent from the *previous* hop, whose pinned DNS no longer describes
 *    where the connection is going.
 *  - **The rebind.** The address that passed the check at subscribe time is not
 *    the address a poll resolves an hour later. Re-checking per hop, per fetch,
 *    is what closes that; the pinned agent is what stops the name being resolved
 *    a second time between the check and the connection.
 *
 * So each hop is resolved, judged and pinned on its own. This is the same shape
 * `llm/articleFetch.ts` already used for article pages, lifted out so the feed
 * fetcher - which is the older and much larger surface, since every subscription
 * on the instance is polled on a timer - is held to it too.
 *
 * Throws rather than returning null: every caller here already distinguishes a
 * failed fetch from a bad one, and a feed that has been pointed at the inside of
 * the network should show up in the feed's own error log saying so.
 */

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number; size?: number };

const MAX_REDIRECTS = 4;

/**
 * Which 3xx codes mean "go and look over there".
 *
 * Listed rather than tested as `>= 300 && < 400`, because **304 is in that range
 * and is not a redirect**. The feed fetcher sends If-None-Match on every poll and
 * a healthy unchanged feed answers 304 all day; treating that as a redirect would
 * look for a Location header, not find one, and report every well-behaved feed on
 * the instance as broken.
 */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Exported so the 304 rule above can be asserted rather than just described. */
export function isRedirectStatus(status: number): boolean {
  return REDIRECTS.has(status);
}

export async function safeFetch(startUrl: string, opts: FetchOptions = {}): Promise<Response> {
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // The reason is carried into the message rather than dropped. This string
    // is what ends up in Feed.lastError and in the admin panel's feed health
    // table, so "Address is not allowed: <url>" full stop was the least useful
    // possible thing to print - it named the feed the admin was already looking
    // at and said nothing about the fault.
    const { agent, reason } = await resolveSafeAgent(url);
    if (!agent) {
      throw new Error(
        hop === 0
          ? `Couldn't fetch ${url}: ${reason}`
          : `Couldn't follow a redirect to ${url}: ${reason}`,
      );
    }

    const res = await nodeFetch(url, {
      ...opts,
      agent,
      // By hand, so the loop above re-runs the gate. See the note at the top.
      redirect: 'manual',
    } as FetchOptions);

    if (!isRedirectStatus(res.status)) return res;

    const location = res.headers.get('location');
    (res.body as unknown as Readable | null)?.destroy();
    if (!location) throw new Error(`Redirect with no location from ${url}`);
    try {
      url = new URL(location, url).toString();
    } catch {
      throw new Error(`Redirect to an unreadable address from ${url}`);
    }
  }

  throw new Error(`Too many redirects from ${startUrl}`);
}
