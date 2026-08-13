import { describe, it, expect } from 'vitest';
import { isSafeUrl, makeSafeAgent } from './isSafeUrl';

// IP-literal hosts are resolved by dns.lookup without a network round-trip, so
// these assertions are deterministic and offline.
describe('isSafeUrl (SSRF guard)', () => {
  it('rejects loopback and private IPv4 ranges', async () => {
    expect(await isSafeUrl('http://127.0.0.1')).toBe(false);
    expect(await isSafeUrl('http://10.0.0.5')).toBe(false);
    expect(await isSafeUrl('http://172.16.4.2')).toBe(false);
    expect(await isSafeUrl('http://192.168.1.1')).toBe(false);
    expect(await isSafeUrl('http://169.254.1.1')).toBe(false);
    expect(await isSafeUrl('http://0.0.0.0')).toBe(false);
  });

  it('rejects IPv6 loopback, unspecified, unique-local and multicast', async () => {
    expect(await isSafeUrl('http://[::1]')).toBe(false);
    expect(await isSafeUrl('http://[::]')).toBe(false);
    expect(await isSafeUrl('http://[fd00::1]')).toBe(false);
    expect(await isSafeUrl('http://[fe80::1]')).toBe(false);
    expect(await isSafeUrl('http://[ff02::1]')).toBe(false);
  });

  // An IPv4 address written as an IPv6 literal. These are valid URLs that every
  // socket stack connects to the embedded IPv4 address, and they used to sail
  // through the IPv6 branch: the guard was checking a string prefix, and
  // `::ffff:127.0.0.1` starts with none of the private ones.
  it('rejects IPv4-mapped IPv6 forms of private addresses', async () => {
    expect(await isSafeUrl('http://[::ffff:127.0.0.1]')).toBe(false);
    expect(await isSafeUrl('http://[::ffff:169.254.169.254]')).toBe(false);
    expect(await isSafeUrl('http://[::ffff:10.0.0.1]')).toBe(false);
    expect(await isSafeUrl('http://[::ffff:192.168.1.1]')).toBe(false);
  });

  it('still allows an IPv4-mapped public address', async () => {
    expect(await isSafeUrl('http://[::ffff:8.8.8.8]')).toBe(true);
  });

  // Ranges that are not RFC1918 but are equally not the public internet.
  it('rejects CGNAT, benchmarking, protocol-assignment, multicast and reserved v4', async () => {
    expect(await isSafeUrl('http://100.64.1.1')).toBe(false);      // Tailscale et al
    expect(await isSafeUrl('http://198.18.0.1')).toBe(false);      // benchmarking
    expect(await isSafeUrl('http://192.0.0.1')).toBe(false);       // IETF assignments
    expect(await isSafeUrl('http://224.0.0.1')).toBe(false);       // multicast
    expect(await isSafeUrl('http://240.0.0.1')).toBe(false);       // reserved
    expect(await isSafeUrl('http://255.255.255.255')).toBe(false); // broadcast
  });

  // The boundaries of the ranges above, so a future tidy-up cannot quietly
  // widen or narrow one by an octet.
  it('keeps the neighbours of those ranges public', async () => {
    expect(await isSafeUrl('http://100.63.255.255')).toBe(true);
    expect(await isSafeUrl('http://100.128.0.1')).toBe(true);
    expect(await isSafeUrl('http://198.17.0.1')).toBe(true);
    expect(await isSafeUrl('http://198.20.0.1')).toBe(true);
    expect(await isSafeUrl('http://192.1.0.1')).toBe(true);
    expect(await isSafeUrl('http://223.255.255.255')).toBe(true);
  });

  it('allows a public IP', async () => {
    expect(await isSafeUrl('https://8.8.8.8')).toBe(true);
  });

  it('rejects non-http(s) schemes and invalid URLs', async () => {
    expect(await isSafeUrl('ftp://8.8.8.8')).toBe(false);
    expect(await isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(await isSafeUrl('not a url')).toBe(false);
  });
});

// The boolean guard above is the same code path, so it passed happily while the
// agent it returns could not open a single connection. These call the pinned
// lookup the way Node does, which is the part that actually broke.
describe('makeSafeAgent pinned lookup', () => {
  async function lookupOf(url: string) {
    const agent = await makeSafeAgent(url);
    expect(agent).not.toBeNull();
    const fn = (agent as unknown as { options: { lookup?: unknown } }).options.lookup;
    expect(typeof fn).toBe('function');
    return fn as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
  }

  it('answers the single-address form with (address, family)', async () => {
    const lookup = await lookupOf('https://8.8.8.8');
    const args = await new Promise<unknown[]>(res => lookup('8.8.8.8', {}, (...a) => res(a)));
    expect(args).toEqual([null, '8.8.8.8', 4]);
  });

  // autoSelectFamily (on by default since Node 20) takes this branch. Answering
  // it with the form above fails the connect with "Invalid IP address:
  // undefined", and callers report it as missing page metadata.
  it('answers the all:true form with an array', async () => {
    const lookup = await lookupOf('https://8.8.8.8');
    const args = await new Promise<unknown[]>(res => lookup('8.8.8.8', { all: true }, (...a) => res(a)));
    expect(args).toEqual([null, [{ address: '8.8.8.8', family: 4 }]]);
  });

  it('reports family 6 for an IPv6 host', async () => {
    const lookup = await lookupOf('https://[2001:4860:4860::8888]');
    const args = await new Promise<unknown[]>(res => lookup('x', { all: true }, (...a) => res(a)));
    expect(args).toEqual([null, [{ address: '2001:4860:4860::8888', family: 6 }]]);
  });
});
