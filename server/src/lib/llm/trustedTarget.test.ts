import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveTarget, ChatRequest, LlmError } from './chat';
import { PROVIDERS } from './providers';
import { privateHostAllowed, privateHostAllowlist, privateHostPredicate } from './operatorEnv';

/**
 * The one deliberate exception in the SSRF gate, and the checks that keep it one.
 *
 * `trusted` lets the *site model* — the endpoint an operator configures for AI
 * personas — live at a private address, which is what allows an Ollama container
 * or a GPU box on the LAN to serve it without being published to the internet.
 *
 * Everything here is about how little that flag grants on its own. It does not
 * disable the address check; it only permits a private address whose **host the
 * operator named in the environment**. Site models are configured in the admin
 * panel, so without that split an admin session would be a port scanner pointed
 * at the network — the panel can change which model answers, and cannot widen
 * what the server is able to reach.
 */

const ENV = ['OPERATOR_LLM_PRIVATE_HOSTS', 'OPERATOR_LLM_BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function request(over: Partial<ChatRequest>): ChatRequest {
  return {
    provider: PROVIDERS.compatible,
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1:8b',
    system: 's',
    turns: [{ role: 'user', content: 'hi' }],
    maxTokens: 10,
    ...over,
  };
}

describe('privateHostAllowlist', () => {
  it('is empty when nothing is set', () => {
    expect(privateHostAllowlist()).toEqual([]);
  });

  it('splits, trims and lowercases entries', () => {
    process.env.OPERATOR_LLM_PRIVATE_HOSTS = ' Ollama , 192.168.1.50,  ';
    expect(privateHostAllowlist()).toEqual(['ollama', '192.168.1.50']);
  });

  // An operator upgrading from v1.22.0 had a working private endpoint set this
  // way and must not find it refused by a variable they have not read about.
  it('always includes the legacy OPERATOR_LLM_BASE_URL host', () => {
    process.env.OPERATOR_LLM_BASE_URL = 'http://legacy-ollama:11434/v1';
    expect(privateHostAllowlist()).toContain('legacy-ollama');
  });

  it('does not duplicate the legacy host when it is also listed', () => {
    process.env.OPERATOR_LLM_PRIVATE_HOSTS = 'ollama';
    process.env.OPERATOR_LLM_BASE_URL = 'http://ollama:11434/v1';
    expect(privateHostAllowlist()).toEqual(['ollama']);
  });

  it('survives a malformed legacy base URL', () => {
    process.env.OPERATOR_LLM_BASE_URL = 'not a url';
    expect(() => privateHostAllowlist()).not.toThrow();
  });
});

describe('privateHostAllowed', () => {
  beforeEach(() => { process.env.OPERATOR_LLM_PRIVATE_HOSTS = 'ollama,192.168.1.50'; });

  it('matches on the hostname, for a container reached by name', () => {
    // The address is Docker-assigned and changes on recreate, which is exactly
    // why the *name* has to be matchable.
    expect(privateHostAllowed('ollama', '172.18.0.4')).toBe(true);
  });

  it('matches on the address, for a LAN box typed as an IP', () => {
    expect(privateHostAllowed('192.168.1.50', '192.168.1.50')).toBe(true);
  });

  it('is case-insensitive on the hostname', () => {
    expect(privateHostAllowed('OLLAMA', '172.18.0.4')).toBe(true);
  });

  // Exact match only — the whole allowlist is worthless if a listed name
  // authorises names that merely contain it.
  it('does not match a suffix or a prefix', () => {
    expect(privateHostAllowed('ollama.evil.example', '10.0.0.1')).toBe(false);
    expect(privateHostAllowed('evil-ollama', '10.0.0.1')).toBe(false);
    expect(privateHostAllowed('192.168.1.500', '192.168.1.500')).toBe(false);
    expect(privateHostAllowed('192.168.1.5', '192.168.1.5')).toBe(false);
  });

  it('refuses an unlisted host', () => {
    expect(privateHostAllowed('192.168.1.99', '192.168.1.99')).toBe(false);
  });

  it('refuses everything when the allowlist is empty', () => {
    delete process.env.OPERATOR_LLM_PRIVATE_HOSTS;
    expect(privateHostAllowed('ollama', '172.18.0.4')).toBe(false);
  });
});

describe('privateHostPredicate', () => {
  // Undefined rather than a false-returning function, so an instance that has
  // configured nothing takes the identical code path it took before the feature.
  it('is undefined when nothing is allowlisted', () => {
    expect(privateHostPredicate()).toBeUndefined();
  });
  it('is a function once something is', () => {
    process.env.OPERATOR_LLM_PRIVATE_HOSTS = 'ollama';
    expect(typeof privateHostPredicate()).toBe('function');
  });
});

describe('resolveTarget — what the trusted flag actually buys', () => {
  it('reaches an allowlisted loopback address', async () => {
    process.env.OPERATOR_LLM_PRIVATE_HOSTS = '127.0.0.1';
    const { url, agent } = await resolveTarget(request({ trusted: true }));
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    // Still pinned. Approving a host is not the same as switching the
    // protection off — the connection goes to the address just validated.
    expect(agent).toBeDefined();
  });

  it('refuses a private address that is NOT allowlisted, flag or no flag', async () => {
    process.env.OPERATOR_LLM_PRIVATE_HOSTS = '192.168.1.50';
    await expect(
      resolveTarget(request({ trusted: true, baseUrl: 'http://127.0.0.1:11434/v1' })),
    ).rejects.toThrow(LlmError);
  });

  // The property that makes the flag safe to set: with nothing allowlisted it
  // changes nothing at all, so a route that set it by mistake gains nothing.
  it('grants nothing when the allowlist is empty', async () => {
    await expect(resolveTarget(request({ trusted: true }))).rejects.toThrow(/private address/);
  });

  it('refuses an allowlisted address when the flag is absent', async () => {
    // What a *user's* credential pointed at the internal box looks like. It must
    // fail like any other private address, allowlist or not.
    process.env.OPERATOR_LLM_PRIVATE_HOSTS = '127.0.0.1';
    await expect(resolveTarget(request({}))).rejects.toThrow(/private address/);
  });

  it('names the variable in the error, since only an admin sees it', async () => {
    await expect(resolveTarget(request({ trusted: true })))
      .rejects.toThrow(/OPERATOR_LLM_PRIVATE_HOSTS/);
  });

  it('still requires a base URL', async () => {
    await expect(resolveTarget(request({ trusted: true, baseUrl: '' })))
      .rejects.toThrow(/needs a base URL/);
  });

  it('appends /chat/completions only when the base has no version segment', async () => {
    process.env.OPERATOR_LLM_PRIVATE_HOSTS = '127.0.0.1';
    const withV = await resolveTarget(request({ trusted: true, baseUrl: 'http://127.0.0.1:11434/v1' }));
    expect(withV.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const without = await resolveTarget(request({ trusted: true, baseUrl: 'http://127.0.0.1:11434' }));
    expect(without.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});
