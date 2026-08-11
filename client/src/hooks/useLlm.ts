import { useState, useEffect, useCallback } from 'react';
import {
  Provider, Credential, CredentialInput,
  listProviders, listCredentials, createCredential, updateCredential, deleteCredential,
} from '../services/llm';

/**
 * The account's connected models.
 *
 * `hasModel` is what every AI affordance in the app gates on. It starts false
 * and only becomes true once the list has actually loaded, which is why
 * `loaded` is separate: an Explore button that flashes into existence and out
 * again on every page load is worse than one that appears a beat late.
 *
 * Nothing here ever holds an API key. The server does not send them back, so
 * there is no client state that could leak one — the edit form below sends a
 * key up and forgets it.
 */
export function useLlm(accessToken: string | null) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The two requests are settled independently, and that is the whole point.
   *
   * They fail for different reasons and mean different things. The provider
   * list is static data the server always has; the credential list touches the
   * database. Loading them in one try/catch meant a database error (a migration
   * not yet applied, most obviously) emptied the provider list too, and the
   * settings screen then rendered an add-a-model form with no providers in it,
   * no fields, and nothing said. A form with no inputs is the worst way to
   * report a server error.
   *
   * So: providers surviving on their own keeps the form usable, and `error`
   * exists so a failure is stated rather than shown as an empty list.
   */
  const load = useCallback(async () => {
    if (!accessToken) {
      setCredentials([]); setProviders([]); setLoaded(false); setError(null);
      return;
    }
    const [p, c] = await Promise.allSettled([listProviders(), listCredentials()]);

    if (p.status === 'fulfilled') setProviders(p.value.providers);
    else setProviders([]);

    if (c.status === 'fulfilled') setCredentials(c.value.credentials);
    else setCredentials([]);

    setError(
      p.status === 'rejected' || c.status === 'rejected'
        ? 'Newt could not read your AI settings from the server. If this instance was just updated, the database migration may not have been applied yet.'
        : null,
    );
    setLoaded(true);
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const add = useCallback(async (input: CredentialInput) => {
    const created = await createCredential(input);
    // Refetch rather than append: creating a default clears the flag on every
    // other row, and the server is the one that decided which.
    await load();
    return created;
  }, [load]);

  const edit = useCallback(async (id: string, patch: Partial<CredentialInput>) => {
    await updateCredential(id, patch);
    await load();
  }, [load]);

  const remove = useCallback(async (id: string) => {
    await deleteCredential(id);
    await load();
  }, [load]);

  const defaultCredential = credentials.find(c => c.isDefault) ?? credentials[0] ?? null;

  return {
    providers,
    credentials,
    loaded,
    error,
    hasModel: loaded && credentials.length > 0,
    defaultCredential,
    add,
    edit,
    remove,
    reload: load,
  };
}
