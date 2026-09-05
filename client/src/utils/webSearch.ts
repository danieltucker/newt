/**
 * The web search engines, in one table.
 *
 * This used to live in SearchBar as two overlapping lists — one keyed by the
 * setting's value, one by the slash prefix — which was fine while the bar was
 * the only thing that sent anybody to a search engine. The search page changed
 * that: a plain query now stops here rather than going straight out, so the
 * page has to be able to offer the web as the next step, and it must offer the
 * engine the reader actually chose in settings.
 */

export interface WebEngine {
  /** The value stored in settings.searchEngine. */
  id: string;
  label: string;
  url: (query: string) => string;
}

export const WEB_ENGINES: readonly WebEngine[] = [
  { id: 'google',     label: 'Google',     url: q => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  { id: 'bing',       label: 'Bing',       url: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { id: 'brave',      label: 'Brave',      url: q => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
];

/** Google for anything unrecognised — including a setting from a later version. */
export function webEngine(id: string | undefined): WebEngine {
  return WEB_ENGINES.find(e => e.id === id) ?? WEB_ENGINES[0];
}

export function webSearchUrl(id: string | undefined, query: string): string {
  return webEngine(id).url(query);
}
