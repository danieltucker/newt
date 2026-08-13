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
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||                              // "this network"
      a === 10 ||                             // RFC1918
      a === 127 ||                            // loopback
      (a === 100 && b >= 64 && b <= 127) ||   // RFC6598 CGNAT - Tailscale lives here
      (a === 169 && b === 254) ||             // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||    // RFC1918
      (a === 192 && b === 0) ||               // IETF protocol assignments
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

/**
 * Resolves the URL's hostname, validates it's not a private/internal IP, then
 * returns an HTTP/HTTPS agent whose lookup function is pinned to that resolved
 * address. Using this agent on the subsequent fetch prevents DNS rebinding:
 * the same IP that passed the check is the one used for the connection.
 *
 * Returns null if the URL is invalid, uses a non-HTTP/S scheme, or resolves
 * to a private address.
 */
export async function makeSafeAgent(urlStr: string): Promise<http.Agent | https.Agent | null> {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  let address: string;
  try {
    const result = await lookup(parsed.hostname);
    address = result.address;
  } catch { return null; }

  if (isPrivateIp(address)) return null;

  const family = net.isIPv6(address) ? 6 : 4;
  const AgentClass = parsed.protocol === 'https:' ? https.Agent : http.Agent;
  return new AgentClass({ lookup: pinnedLookup(address, family) } as ConstructorParameters<typeof AgentClass>[0]);
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
