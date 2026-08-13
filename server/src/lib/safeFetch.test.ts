import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { safeFetch, isRedirectStatus } from './safeFetch';

// A real loopback server. The point of these tests is what safeFetch does with
// a *response*, and loopback is also the address the gate must refuse — so the
// server doubles as both the fixture and the thing we must not be able to reach
// by redirect.
let server: http.Server | null = null;

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise(resolve => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(() => { server?.close(); server = null; });

describe('safeFetch', () => {
  it('refuses a private address outright', async () => {
    const base = await listen((_req, res) => res.end('should never be read'));
    await expect(safeFetch(base)).rejects.toThrow(/not allowed/);
  });

  it('refuses an IPv4-mapped IPv6 spelling of the same address', async () => {
    const base = await listen((_req, res) => res.end('nope'));
    const port = new URL(base).port;
    await expect(safeFetch(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrow(/not allowed/);
  });

  it('refuses the metadata service', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not allowed/);
  });

  // A redirect is refused at the hop it points at, not waved through because
  // the first address was fine. Loopback is rejected at hop 0 here, which is
  // the same code path a later hop takes.
  it('re-checks the address a redirect points at', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    await expect(safeFetch(base)).rejects.toThrow(/not allowed/);
  });
});

describe('isRedirectStatus', () => {
  // The trap this class of code falls into: 304 is a 3xx and is *not* a
  // redirect. The feed fetcher sends If-None-Match on every poll, so a healthy
  // unchanged feed answers 304 constantly. Classifying it as a redirect would
  // send safeFetch looking for a Location header it will never find, and report
  // every well-behaved feed on the instance as broken.
  it('does not classify 304 as a redirect', () => {
    expect(isRedirectStatus(304)).toBe(false);
  });

  it('classifies the real redirects', () => {
    for (const s of [301, 302, 303, 307, 308]) expect(isRedirectStatus(s)).toBe(true);
  });

  it('classifies nothing else in the 3xx range', () => {
    for (const s of [300, 305, 306, 309]) expect(isRedirectStatus(s)).toBe(false);
  });

  it('classifies success and error codes as non-redirects', () => {
    for (const s of [200, 204, 400, 404, 429, 500]) expect(isRedirectStatus(s)).toBe(false);
  });
});
