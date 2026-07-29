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

  it('rejects IPv6 loopback', async () => {
    expect(await isSafeUrl('http://[::1]')).toBe(false);
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
