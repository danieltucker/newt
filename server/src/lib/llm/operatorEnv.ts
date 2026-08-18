/**
 * Which private hosts the operator has authorised the site model to reach.
 *
 * This module exists to have no imports. It decides whether a request may reach
 * a private address, and it is better that the decision depends on nothing but
 * `process.env` and this file — there is no third module whose behaviour could
 * change what the guard lets through, and no import cycle to reason about
 * (operator.ts needs LlmError from chat.ts, so chat.ts cannot import it back).
 *
 * ── Why an environment variable and not a setting ──
 * Site models are configured in the admin panel, which is a real convenience:
 * switching model, adding a second box, disabling one for the evening. But the
 * *capability* those settings exercise — making the server open a connection to
 * an address inside your network — is a different order of thing from choosing
 * a model name, and the two should not need the same level of access.
 *
 * Setting an env var requires shell access to the host. Adding a row to a table
 * requires an admin web session, which is a far cheaper thing to obtain: a
 * borrowed laptop, a stolen cookie, a compromised password. Without this split,
 * an admin session becomes a port scanner pointed at the LAN, and the operator
 * has no way to bound it.
 *
 * So: the panel may name any endpoint. A **public** endpoint needs no entry
 * here. A **private** one works only if its host was named on the host machine,
 * once, deliberately.
 */

export function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Legacy single-endpoint configuration, kept working.
 *
 * v1.22.0 configured the site model entirely through OPERATOR_LLM_BASE_URL and
 * OPERATOR_LLM_MODEL. Those still function as a fallback when no site model has
 * been added in the panel, so upgrading does not turn personas off — see
 * resolveSiteModel. The panel shows this one as read-only, because a row it
 * cannot edit pretending to be editable is worse than one that says where it
 * came from.
 */
export function operatorBaseUrl(): string | null {
  return normalizeBase(process.env.OPERATOR_LLM_BASE_URL ?? '') || null;
}

/**
 * The hosts an operator has authorised, lowercased.
 *
 * Comma-separated, and entries may be either a hostname (`ollama`) or a literal
 * address (`192.168.1.50`). Both forms are needed and they are not
 * interchangeable:
 *
 *   - A compose service is reached by **name**. Its container address is
 *     assigned by Docker and changes on recreate, so allowlisting the address
 *     would break on the next `up -d`.
 *   - A box on the LAN is usually typed as an **address**, and has no name the
 *     server can resolve.
 *
 * The legacy OPERATOR_LLM_BASE_URL's own host is always included. An operator
 * upgrading from v1.22.0 had a working private endpoint and must not find it
 * refused because a new variable exists that they have not read about yet.
 */
export function privateHostAllowlist(): string[] {
  const listed = (process.env.OPERATOR_LLM_PRIVATE_HOSTS ?? '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);

  const legacy = operatorBaseUrl();
  if (legacy) {
    try {
      const host = new URL(legacy).hostname.toLowerCase();
      if (host && !listed.includes(host)) listed.push(host);
    } catch {
      // A malformed OPERATOR_LLM_BASE_URL contributes nothing rather than
      // throwing here — resolveSiteModel reports it where an admin will see it.
    }
  }
  return listed;
}

/**
 * Whether this hostname/address pair may be reached despite being private.
 *
 * Both are checked because the caller may have been given either form: a URL
 * written as `http://ollama:11434` arrives with hostname `ollama` and some
 * Docker-assigned address, while `http://192.168.1.50:11434` arrives with both
 * equal to the address. Matching either against the list covers both without the
 * operator having to know which one Newt will compare.
 *
 * Exact match only — no suffix or prefix matching. `ollama` must not authorise
 * `ollama.evil.example`, and `10.0.0.5` must not authorise `10.0.0.50`.
 */
export function privateHostAllowed(hostname: string, address: string): boolean {
  const allowed = privateHostAllowlist();
  if (allowed.length === 0) return false;
  const host = hostname.toLowerCase();
  return allowed.includes(host) || allowed.includes(address.toLowerCase());
}

/**
 * The predicate for resolveSafeAgent, or undefined when nothing is allowlisted.
 *
 * Undefined rather than a function returning false, so that an instance with no
 * allowlist takes exactly the code path it took before this feature existed.
 */
export function privateHostPredicate(): ((hostname: string, address: string) => boolean) | undefined {
  return privateHostAllowlist().length > 0 ? privateHostAllowed : undefined;
}
