import { lookup } from 'dns/promises';
import net from 'net';
import http from 'http';
import https from 'https';

/**
 * Anything that is not a public, routable unicast address.
 *
 * Written as a deny-list of "not the public internet" rather than an allow-list
 * because the caller's question is "may I fetch this", and the failure mode of
 * missing a range is reaching something inside the network. Unknown input
 * returns true (unsafe) for the same reason.
 */
function isPrivateIp(ip: string): boolean {
  // An IPv4 address wearing an IPv6 hat. `::ffff:127.0.0.1` is a valid IPv6
  // literal that every socket stack connects to 127.0.0.1, and it passed the
  // IPv6 branch below untouched - so `http://[::ffff:127.0.0.1]/` reached
  // loopback and `http://[::ffff:169.254.169.254]/` reached the cloud metadata
  // service, through a guard whose whole job was to stop exactly that. Unwrap
  // to the address it really is and judge that.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  if (mapped && net.isIPv4(mapped[1])) return isPrivateIp(mapped[1]);

  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return (
      a === 0 ||                              // "this network"
      a === 10 ||                             // RFC1918
      a === 127 ||                            // loopback
      (a === 100 && b >= 64 && b <= 127) ||   // RFC6598 CGNAT - Tailscale lives here
      (a === 169 && b === 254) ||             // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||    // RFC1918
      // 192.0.0.0/24 and 192.0.2.0/24 only — *not* 192.0.0.0/16.
      //
      // This was `a === 192 && b === 0`, which blocked the whole /16. The
      // reserved parts of 192.0 are two /24s: 192.0.0.0/24 (IETF protocol
      // assignments) and 192.0.2.0/24 (TEST-NET-1). Everything else under
      // 192.0 is ordinary routable space that is allocated and in use —
      // 192.0.64.0/18 is Automattic's, which is where WordPress.com and every
      // site on WordPress VIP lives. TechCrunch is one of them (192.0.66.220),
      // so the guard was refusing to fetch a perfectly public feed and
      // reporting it as an address that isn't allowed.
      (a === 192 && b === 0 && c === 0) ||    // IETF protocol assignments
      (a === 192 && b === 0 && c === 2) ||    // TEST-NET-1
      (a === 192 && b === 168) ||             // RFC1918
      (a === 198 && b >= 18 && b <= 19) ||    // benchmarking
      a >= 224                                // multicast, reserved, broadcast
    );
  }

  if (net.isIPv6(ip)) {
    const n = ip.toLowerCase();
    return (
      n === '::' ||                           // unspecified - connects to local
      n === '::1' ||                          // loopback
      n.startsWith('fc') || n.startsWith('fd') ||   // unique local
      n.startsWith('fe8') || n.startsWith('fe9') ||
      n.startsWith('fea') || n.startsWith('feb') || // link-local fe80::/10
      n.startsWith('ff')                      // multicast
    );
  }

  return true;
}

export type SafeAgent = http.Agent | https.Agent;

/**
 * Either an agent, or the reason there isn't one.
 *
 * The reason exists because four quite different faults used to arrive as the
 * same `null`: a URL that doesn't parse, a scheme we don't speak, a name that
 * doesn't resolve, and an address we refuse to connect to. Callers turned that
 * into one sentence — "Address is not allowed" — and an admin looking at a
 * broken feed had no way to tell a DNS outage from a blocked range, which is
 * the single most useful thing to know when a feed stops working.
 */
export type SafeAgentResult =
  | { agent: SafeAgent; address: string; reason?: undefined }
  | { agent: null; address: null; reason: string };

/**
 * Resolves the URL's hostname, validates it's not a private/internal IP, then
 * returns an HTTP/HTTPS agent whose lookup function is pinned to that resolved
 * address. Using this agent on the subsequent fetch prevents DNS rebinding:
 * the same IP that passed the check is the one used for the connection.
 *
 * Reports *why* it refused. Prefer this over `makeSafeAgent` anywhere the
 * failure is shown to a human.
 */
export async function resolveSafeAgent(urlStr: string): Promise<SafeAgentResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { agent: null, address: null, reason: 'the address could not be parsed as a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      agent: null,
      address: null,
      reason: `the scheme "${parsed.protocol}" is not allowed - only http and https are fetched`,
    };
  }

  let address: string;
  try {
    const result = await lookup(parsed.hostname);
    address = result.address;
  } catch (err) {
    // The DNS error code is the whole point of surfacing this separately:
    // ENOTFOUND is a dead or misspelled hostname, EAI_AGAIN is the resolver
    // itself failing, and those want opposite responses from an admin.
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      agent: null,
      address: null,
      reason: `DNS lookup for "${parsed.hostname}" failed${code ? ` (${code})` : ''}`,
    };
  }

  if (isPrivateIp(address)) {
    return {
      agent: null,
      address: null,
      reason: `"${parsed.hostname}" resolved to ${address}, which is not allowed - `
        + 'that is a private, loopback or otherwise reserved address rather than the public internet',
    };
  }

  const family = net.isIPv6(address) ? 6 : 4;
  const AgentClass = parsed.protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new AgentClass(
    { lookup: pinnedLookup(address, family) } as ConstructorParameters<typeof AgentClass>[0],
  );
  return { agent, address };
}

/**
 * The agent alone, or null. Kept for callers that only branch on success and
 * have nowhere to print a reason.
 */
export async function makeSafeAgent(urlStr: string): Promise<SafeAgent | null> {
  return (await resolveSafeAgent(urlStr)).agent;
}

type LookupCallback =
  (err: Error | null, addr: string | { address: string; family: number }[], fam?: number) => void;

/**
 * A dns.lookup stand-in that always answers with one already-vetted address.
 *
 * It has to answer in two different shapes. Node ≥20 turns on `autoSelectFamily`
 * by default, and that path asks a custom lookup for *every* address by passing
 * `all: true`, expecting an array of `{ address, family }` back. Replying in the
 * single-address form there aborts the connection with "Invalid IP address:
 * undefined" — which every caller here reads as "the site had no metadata",
 * because a failed fetch and a page without an og:title are indistinguishable
 * once the error is swallowed. So the breakage is total and completely silent.
 */
function pinnedLookup(address: string, family: number) {
  return (_host: string, opts: { all?: boolean } | undefined, cb: LookupCallback) => {
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/** Convenience wrapper — use makeSafeAgent when you also need to fetch. */
export async function isSafeUrl(urlStr: string): Promise<boolean> {
  return (await makeSafeAgent(urlStr)) !== null;
}
