import { useState, useMemo, useRef, useEffect } from 'react';
import styles from './SearchBar.module.css';
import { bookmarkHref, faviconUrl } from '../utils/color';
import { noteText, noteSnippet } from '../utils/noteText';

// Rotating placeholder hints - cycled with a per-letter flip animation
const HINTS = [
  'Search the web or enter an address',
  'Ask Claude anything with /c your question',
  'Search your bookmarks, notes, feeds and reading list - try #tag',
  '/g Google · /d DuckDuckGo · /b Bing · /br Brave',
  'Paste a URL to go straight there',
];
const HINT_INTERVAL_MS = 6000;
const HINT_FLIP_MS = 340;

const SEARCH_URLS: Record<string, (q: string) => string> = {
  google:     q => `https://www.google.com/search?q=${q}`,
  duckduckgo: q => `https://duckduckgo.com/?q=${q}`,
  bing:       q => `https://www.bing.com/search?q=${q}`,
  brave:      q => `https://search.brave.com/search?q=${q}`,
};

// Slash shortcuts: /g → Google, /d → DuckDuckGo, /b → Bing, /br → Brave, /c → Claude
// Longer prefixes listed first so /br is matched before /b
const SHORTCUTS = [
  { prefix: '/br', engine: 'Brave',      verb: 'Search', url: (q: string) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
  { prefix: '/g',  engine: 'Google',     verb: 'Search', url: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { prefix: '/d',  engine: 'DuckDuckGo', verb: 'Search', url: (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  { prefix: '/b',  engine: 'Bing',       verb: 'Search', url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { prefix: '/c',  engine: 'Claude',     verb: 'Ask',    url: (q: string) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
];

function isUrl(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return true;
  const noProto = trimmed.replace(/^www\./, '');
  return /^[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(noProto);
}

interface BookmarkHint {
  id: string;
  domain: string;
  name: string;
}

interface ArticleHint {
  id: string;
  url: string;
  title: string;
  source: string;
  tag?: string;          // reading list: comma-separated tags
  categories?: string[]; // feed articles
}

// All tag-like labels on an item, normalised
function tagsOf(a: ArticleHint): string[] {
  const fromTag = a.tag ? a.tag.split(',').map(t => t.trim()).filter(Boolean) : [];
  return [...fromTag, ...(a.categories ?? [])];
}

interface NoteHint {
  id: string;
  title: string;
  body: string;   // editor HTML - searched as plain text
}

type Suggestion =
  | { kind: 'note';     id: string; title: string; snippet: string }
  | { kind: 'bookmark'; id: string; name: string; domain: string }
  | { kind: 'article';  id: string; title: string; source: string; url: string; matchedTag?: string }
  | { kind: 'search';   text: string; url: string }
  | { kind: 'url';      text: string; url: string }
  | { kind: 'shortcut'; text: string; url: string; engine: string; verb: string };

interface Props {
  searchEngine?: string;
  searchNewTab?: boolean;
  bookmarks?: BookmarkHint[];
  readingItems?: ArticleHint[];
  feedArticles?: ArticleHint[];
  notes?: NoteHint[];
  onOpenNote?: (id: string, query: string) => void;
}

export default function SearchBar({
  searchEngine = 'google',
  searchNewTab = false,
  bookmarks = [],
  readingItems = [],
  feedArticles = [],
  notes = [],
  onOpenNote,
}: Props) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rotating hint: flip the current one out, swap text, flip the next one in
  const [hintIdx, setHintIdx] = useState(0);
  const [hintPhase, setHintPhase] = useState<'in' | 'out'>('in');
  useEffect(() => {
    if (value) return; // pause rotation while the user is typing
    const interval = setInterval(() => {
      setHintPhase('out');
      setTimeout(() => {
        setHintIdx(i => (i + 1) % HINTS.length);
        setHintPhase('in');
      }, HINT_FLIP_MS);
    }, HINT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [value]);

  const suggestions = useMemo<Suggestion[]>(() => {
    const raw = value.trim();
    if (!raw) return [];

    // Slash shortcut: recognized the moment the bare prefix is typed ("/c"),
    // then again with the query as it's entered ("/c how do…")
    const shortcut = SHORTCUTS.find(s => raw === s.prefix || raw.startsWith(s.prefix + ' '));
    if (shortcut) {
      const query = raw.slice(shortcut.prefix.length).trim();
      return [{
        kind: 'shortcut',
        text: query,
        url: query ? shortcut.url(query) : '',
        engine: shortcut.engine,
        verb: shortcut.verb,
      }];
    }

    // "#query" searches tags only; otherwise tags match alongside title/source
    const tagOnly = raw.startsWith('#');
    const q = (tagOnly ? raw.slice(1) : raw).toLowerCase().trim();
    const results: Suggestion[] = [];
    if (!q) return results;

    const matchTag = (a: ArticleHint) => tagsOf(a).find(t => t.toLowerCase().includes(q));
    const matchText = (a: ArticleHint) =>
      !tagOnly && (a.title.toLowerCase().includes(q) || a.source.toLowerCase().includes(q));

    // Notes lead the list: they're the user's own writing, and unlike the rest
    // of the results they can't be found anywhere else on the page.
    if (!tagOnly && onOpenNote) {
      for (const n of notes) {
        if (results.filter(r => r.kind === 'note').length >= 3) break;
        const text = noteText(n.body);
        const at = text.toLowerCase().indexOf(q);
        const inTitle = n.title.toLowerCase().includes(q);
        if (at < 0 && !inTitle) continue;
        results.push({
          kind: 'note',
          id: n.id,
          title: n.title.trim() || 'Untitled',
          // Body hits show their context; a title-only hit shows the opening line
          snippet: noteSnippet(text, at >= 0 ? q : '', 70),
        });
      }
    }

    if (!tagOnly) {
      bookmarks
        .filter(b => b.name.toLowerCase().includes(q) || b.domain.toLowerCase().includes(q))
        .slice(0, 5)
        .forEach(b => results.push({ kind: 'bookmark', id: b.id, name: b.name, domain: b.domain }));
    }

    readingItems
      .filter(a => matchText(a) || matchTag(a))
      .slice(0, tagOnly ? 6 : 3)
      .forEach(a => results.push({ kind: 'article', id: a.id, title: a.title, source: a.source, url: a.url, matchedTag: matchTag(a) }));

    feedArticles
      .filter(a => matchText(a) || matchTag(a))
      .slice(0, tagOnly ? 6 : 4)
      .forEach(a => results.push({ kind: 'article', id: `feed-${a.id}`, title: a.title, source: a.source, url: a.url, matchedTag: matchTag(a) }));

    if (tagOnly) return results;

    if (isUrl(raw)) {
      results.push({ kind: 'url', text: raw, url: raw.startsWith('http') ? raw : `https://${raw}` });
    } else {
      const url = (SEARCH_URLS[searchEngine] ?? SEARCH_URLS.google)(encodeURIComponent(raw));
      results.push({ kind: 'search', text: raw, url });
    }

    return results;
  }, [value, bookmarks, readingItems, feedArticles, notes, onOpenNote, searchEngine]);

  function navigate(url: string) {
    if (searchNewTab) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      window.location.href = url;
    }
    setValue('');
    setOpen(false);
    setSelectedIndex(-1);
  }

  function pick(item: Suggestion) {
    if (item.kind === 'note') {
      onOpenNote?.(item.id, value.trim());
      setValue('');
      setOpen(false);
      setSelectedIndex(-1);
    } else if (item.kind === 'bookmark') {
      navigate(bookmarkHref(item.domain));
    } else if (item.url) {
      navigate(item.url);
    }
    // Bare shortcut prefix (no query yet) - nothing to open
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
      pick(suggestions[selectedIndex]);
      return;
    }
    const q = value.trim();
    if (!q) return;
    // Check slash shortcuts on submit too (e.g. Enter pressed without selecting a suggestion)
    if (SHORTCUTS.some(s => q === s.prefix)) return; // bare prefix - wait for a query
    const shortcut = SHORTCUTS.find(s => q.startsWith(s.prefix + ' '));
    if (shortcut) {
      const query = q.slice(shortcut.prefix.length).trim();
      if (!query) return;
      navigate(shortcut.url(query));
      return;
    }
    const url = isUrl(q)
      ? (q.startsWith('http') ? q : `https://${q}`)
      : (SEARCH_URLS[searchEngine] ?? SEARCH_URLS.google)(encodeURIComponent(q));
    navigate(url);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Escape') {
      setOpen(false);
      setSelectedIndex(-1);
    }
  }

  function handleBlur() {
    blurTimer.current = setTimeout(() => { setOpen(false); setSelectedIndex(-1); }, 150);
  }

  function handleMouseDown(item: Suggestion) {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    pick(item);
  }

  const IconDoc = () => (
    <svg className={styles.resultSvg} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  );

  const IconNote = () => (
    <svg className={styles.resultSvg} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <path d="M8 13h8"/><path d="M8 17h5"/>
    </svg>
  );

  const IconSearch = () => (
    <svg className={styles.resultSvg} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
  );

  const IconLink = () => (
    <svg className={styles.resultSvg} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  );

  return (
    <div className={styles.container}>
      <form className={styles.wrap} onSubmit={handleSubmit}>
        {/* A plain magnifier - the mark leads the bar a few pixels to the left,
            and one glyph saying "Newt" per row is enough. */}
        <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <div className={styles.inputWrap}>
          <input
            className={styles.input}
            type="text"
            value={value}
            onChange={e => { setValue(e.target.value); setOpen(true); setSelectedIndex(-1); }}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (value.trim()) setOpen(true); }}
            onBlur={handleBlur}
            aria-label="Search the web or enter an address"
          />
          {!value && (
            <span className={styles.hint} aria-hidden="true">
              {HINTS[hintIdx].split('').map((ch, i) => (
                <span
                  key={`${hintIdx}-${i}`}
                  className={hintPhase === 'in' ? styles.charIn : styles.charOut}
                  style={{ animationDelay: `${i * 9}ms` }}
                >
                  {ch === ' ' ? ' ' : ch}
                </span>
              ))}
            </span>
          )}
        </div>
      </form>

      {open && suggestions.length > 0 && (
        <div className={styles.dropdown}>
          {suggestions.map((item, i) => {
            const sel = i === selectedIndex;
            if (item.kind === 'note') return (
              <div key={item.id} className={`${styles.result} ${sel ? styles.resultSel : ''}`}
                onMouseDown={() => handleMouseDown(item)} onMouseEnter={() => setSelectedIndex(i)}>
                <div className={styles.resultIconWrap}><IconNote /></div>
                <div className={styles.resultText}>
                  <span className={styles.resultLabel}>{item.title}</span>
                  {item.snippet && <span className={styles.resultSub}>{item.snippet}</span>}
                </div>
                <span className={styles.badge}>Note</span>
              </div>
            );
            if (item.kind === 'bookmark') return (
              <div key={item.id} className={`${styles.result} ${sel ? styles.resultSel : ''}`}
                onMouseDown={() => handleMouseDown(item)} onMouseEnter={() => setSelectedIndex(i)}>
                <img src={faviconUrl(item.domain)} alt="" className={styles.favicon} />
                <div className={styles.resultText}>
                  <span className={styles.resultLabel}>{item.name}</span>
                  <span className={styles.resultSub}>{item.domain}</span>
                </div>
                <span className={styles.badge}>Bookmark</span>
              </div>
            );
            if (item.kind === 'article') return (
              <div key={item.id} className={`${styles.result} ${sel ? styles.resultSel : ''}`}
                onMouseDown={() => handleMouseDown(item)} onMouseEnter={() => setSelectedIndex(i)}>
                <div className={styles.resultIconWrap}><IconDoc /></div>
                <div className={styles.resultText}>
                  <span className={styles.resultLabel}>{item.title}</span>
                  <span className={styles.resultSub}>
                    {item.source}
                    {item.matchedTag && <span className={styles.tagHit}> · #{item.matchedTag}</span>}
                  </span>
                </div>
                <span className={styles.badge}>Article</span>
              </div>
            );
            if (item.kind === 'url') return (
              <div key="url" className={`${styles.result} ${sel ? styles.resultSel : ''}`}
                onMouseDown={() => handleMouseDown(item)} onMouseEnter={() => setSelectedIndex(i)}>
                <div className={styles.resultIconWrap}><IconLink /></div>
                <div className={styles.resultText}>
                  <span className={styles.resultLabel}>Go to <strong>{item.text}</strong></span>
                </div>
              </div>
            );
            if (item.kind === 'shortcut') return (
              <div key="shortcut" className={`${styles.result} ${sel ? styles.resultSel : ''}`}
                onMouseDown={() => handleMouseDown(item)} onMouseEnter={() => setSelectedIndex(i)}>
                <div className={styles.resultIconWrap}><IconSearch /></div>
                <div className={styles.resultText}>
                  <span className={styles.resultLabel}>
                    {item.text
                      ? (item.verb === 'Ask'
                          ? <>Ask <strong>{item.engine}</strong>: <strong>{item.text}</strong></>
                          : <>Search <strong>{item.engine}</strong> for <strong>{item.text}</strong></>)
                      : <>{item.verb} <strong>{item.engine}</strong></>}
                  </span>
                  {!item.text && (
                    <span className={styles.resultSub}>
                      {item.verb === 'Ask' ? 'Type your question…' : 'Type your search…'}
                    </span>
                  )}
                </div>
                <span className={styles.badge}>{item.engine}</span>
              </div>
            );
            return (
              <div key="search" className={`${styles.result} ${sel ? styles.resultSel : ''}`}
                onMouseDown={() => handleMouseDown(item)} onMouseEnter={() => setSelectedIndex(i)}>
                <div className={styles.resultIconWrap}><IconSearch /></div>
                <div className={styles.resultText}>
                  <span className={styles.resultLabel}>Search for <strong>{item.text}</strong></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
