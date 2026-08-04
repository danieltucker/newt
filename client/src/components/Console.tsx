import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './Console.module.css';
import { Folder } from '../types';
import { apiFetch } from '../services/api';
import { parseDomain, deriveName, deriveColor, faviconUrl } from '../utils/color';

// A pending `add` flow: whatever the user left out is collected one line at a
// time. `awaiting` is the field the next typed line answers.
type AddData = { domain?: string; name?: string; folderId?: string };
type AddPending = AddData & { awaiting: 'domain' | 'name' | 'folder' };

export interface AddSitePayload {
  folderId: string; domain: string; name: string; faviconUrl: string; color: string;
}

interface Line {
  id: number;
  kind: 'input' | 'output' | 'error' | 'info';
  text: string;
}

interface Ctx {
  folders: Folder[];
  theme: 'dark' | 'light';
  isAdmin: boolean;
  onSelectFolder: (id: string) => void;
  onSetTheme: (t: 'dark' | 'light' | 'auto') => void;
  onRefreshFeeds: () => void;
  // Emit a line immediately, so long-running commands can stream progress
  push: (text: string | string[], kind?: Line['kind']) => void;
}

type CmdFn = (args: string[], ctx: Ctx) => Promise<string | string[]> | string | string[];

// desc - one-liner for `help` and the suggestion dropdown.
// usage/help - shown by `help <command>`: usage is the signature, help is the
// detail block (parameters, notes, examples).
// admin - command runs server work from the server's own network position
// (feed fan-out, process spawn), so it's hidden from and denied to non-admins.
interface Command {
  desc: string;
  usage?: string;
  help?: string[];
  admin?: boolean;
  run: CmdFn;
}

function col(name: string, desc: string): string {
  return `  ${name.padEnd(12)}${desc}`;
}

const COMMANDS: Record<string, Command> = {
  help: {
    desc: 'List commands, or "help <command>" for details',
    usage: 'help [command]',
    help: [
      'With no argument, lists every command grouped by area.',
      'Pass a command name for its usage, parameters, and examples.',
      '',
      'Examples:',
      '  help ping',
      '  help add',
    ],
    run: (args, { isAdmin }) => {
      const topic = args[0]?.toLowerCase();
      if (topic) {
        const def = COMMANDS[topic];
        if (!def || (def.admin && !isAdmin)) return `No such command: "${topic}". Type "help" for the full list.`;
        const out = [def.usage ? `Usage: ${def.usage}` : topic, '', def.desc];
        if (def.help) out.push('', ...def.help);
        return out;
      }
      return [
        'Network',
        col('ip',        'Your public IP address and location'),
        col('dns',       'dns <host> [A|AAAA|MX|TXT]  - DNS lookup'),
        col('speedtest', 'Latency, download & upload test'),
        ...(isAdmin ? [
          col('ping',    'ping <host>  - ICMP ping (4 packets)'),
          col('tracert', 'tracert <host>  - Trace route to host'),
          col('refresh', 'Force-refresh all RSS feeds'),
        ] : []),
        '',
        'Sites & folders',
        col('add',       'add site <domain> …  ·  add folder <name> …'),
        '',
        'Navigation',
        col('folder',    'folder <name>  - Switch to a folder'),
        '',
        'System',
        col('theme',     'theme <dark|light|auto>  - Switch UI theme'),
        col('cache',     'cache clear  - Clear local cache & reload'),
        col('version',   'App version info'),
        col('clear',     'Clear the console'),
        col('help',      'help [command]  - This list, or per-command detail'),
        '',
        'Tip: "help <command>" shows parameters and examples.',
      ];
    },
  },

  add: {
    desc: 'Add a site or folder',
    usage: 'add site <domain> [name] [folder]  ·  add folder <name> [#color]',
    help: [
      'add site <domain> [name] [folder]',
      '   Add a bookmark. Anything left out is asked for one line at a time.',
      '     domain   The site address, e.g. example.com (must contain a dot)',
      '     name     Optional label; defaults to a name from the domain',
      '     folder   An existing folder (by name, or number when prompted)',
      '',
      'add folder <name> [#color]',
      '   Create a folder and switch to it.',
      '     name     The folder name, e.g. Work or Reading List',
      '     #color   Optional hex color; defaults to one picked from the name',
      '',
      'Examples:',
      '  add site example.com Example News',
      '  add site example.com',
      '  add folder Reading List',
      '  add folder Design #A259FF',
      '',
      'The "site" keyword is optional - "add example.com News" also works.',
    ],
    // Intercepted in the component so it can prompt for missing details - this
    // usage line only shows if it is ever dispatched directly.
    run: () => 'Usage: add site <domain> [name] [folder]  |  add folder <name> [#color]',
  },

  version: {
    desc: 'Show app version',
    run: () => `Newt v${__APP_VERSION__}`,
  },

  clear: {
    desc: 'Clear the console',
    run: () => '__CLEAR__',
  },

  cache: {
    desc: 'Clear local cache & reload',
    usage: 'cache clear',
    help: [
      'Clears this browser\'s cached bookmarks, pinned sites and sidebar state,',
      'then reloads so everything is refetched fresh from the server. Use it if',
      'bookmarks, folders or pins look stale or out of sync.',
      '',
      '  cache clear   Clear the local cache and reload',
    ],
    run: (args) => {
      const sub = (args[0] ?? 'clear').toLowerCase();
      if (sub !== 'clear') return 'Usage: cache clear';
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('bfc_') || k.startsWith('bpc_') || k.startsWith('sidebarExpanded_'))) {
            localStorage.removeItem(k);
          }
        }
      } catch {}
      setTimeout(() => window.location.reload(), 300);
      return 'Cleared local cache - reloading…';
    },
  },

  ip: {
    desc: 'Show your public IP',
    help: [
      'Shows your public IP address with its city/region/country and ISP.',
      'Looked up directly from your browser, so it reflects THIS device and',
      'connection - handy for allow-lists. (The server never sees this request.)',
    ],
    run: async () => {
      // Query the IP echo service from the browser so we get the user's own
      // public IP, not the server's egress address.
      const res = await fetch('https://ipinfo.io/json', { cache: 'no-store' });
      if (!res.ok) return 'Could not fetch IP info.';
      const d = await res.json() as { ip: string; city?: string; region?: string; country?: string; org?: string };
      const loc = [d.city, d.region, d.country].filter(Boolean).join(', ');
      const parts = [`IP   ${d.ip}`];
      if (loc) parts.push(`Loc  ${loc}`);
      if (d.org) parts.push(`ISP  ${d.org}`);
      return parts;
    },
  },

  ping: {
    desc: 'Ping a host',
    usage: 'ping <host>',
    admin: true,
    help: [
      'Sends 4 ICMP echo requests from the server to a host and reports the',
      'round-trip times.',
      '',
      '  host   A domain or IP address, e.g. cloudflare.com or 1.1.1.1',
      '',
      'Example:  ping github.com',
    ],
    run: async ([host]) => {
      if (!host) return 'Usage: ping <host>';
      const res = await apiFetch(`/api/v1/util/ping?host=${encodeURIComponent(host)}`);
      if (!res.ok) return 'Could not reach server.';
      const d = await res.json() as { output: string; error?: boolean };
      return d.output.trim().split('\n').filter(l => l.trim());
    },
  },

  tracert: {
    desc: 'Trace route to a host',
    usage: 'tracert <host>',
    admin: true,
    help: [
      'Traces the network path from the server to a host, listing each hop',
      'and its latency. Can take up to ~30s on long routes.',
      '',
      '  host   A domain or IP address, e.g. example.com',
      '',
      'Example:  tracert bbc.co.uk',
    ],
    run: async ([host]) => {
      if (!host) return 'Usage: tracert <host>';
      const res = await apiFetch(`/api/v1/util/tracert?host=${encodeURIComponent(host)}`);
      if (!res.ok) return 'Could not reach server.';
      const d = await res.json() as { output: string; error?: boolean };
      return d.output.trim().split('\n').filter(l => l.trim());
    },
  },

  dns: {
    desc: 'DNS lookup',
    usage: 'dns <host> [type]',
    help: [
      'Looks up DNS records for a host via Cloudflare DoH.',
      '',
      '  host   The domain to look up, e.g. example.com',
      '  type   Record type (default A): A, AAAA, MX, TXT, CNAME, NS, PTR',
      '',
      'Examples:',
      '  dns example.com',
      '  dns example.com MX',
    ],
    run: async (args) => {
      const host = args[0];
      const type = (args[1] ?? 'A').toUpperCase();
      if (!host) return 'Usage: dns <host> [A|AAAA|MX|TXT|CNAME]';
      const validTypes = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'PTR'];
      if (!validTypes.includes(type)) return `Unknown type "${type}". Valid: ${validTypes.join(', ')}`;
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${encodeURIComponent(type)}`,
        { headers: { Accept: 'application/dns-json' } }
      );
      if (!res.ok) return 'DNS lookup failed.';
      const d = await res.json() as { Answer?: Array<{ data: string; TTL: number }>; Status: number };
      if (!d.Answer?.length) return `No ${type} records found for ${host}`;
      return d.Answer.map(r => `${r.data.padEnd(48)}TTL ${r.TTL}s`);
    },
  },

  refresh: {
    desc: 'Force-refresh all RSS feeds',
    admin: true,
    help: ['Re-fetches every feed you follow, right now, instead of waiting for', 'the periodic refresh. Takes no arguments.'],
    run: async (_args, { onRefreshFeeds }) => {
      const res = await apiFetch('/api/v1/feeds/refresh-all', { method: 'POST' });
      if (!res.ok) return 'Refresh failed - check server logs.';
      const d = await res.json() as { refreshed: number };
      if (d.refreshed === 0) return "You aren't following any feeds yet.";
      onRefreshFeeds();
      return `Refreshed ${d.refreshed} feed${d.refreshed === 1 ? '' : 's'}.`;
    },
  },

  speedtest: {
    desc: 'Latency, download & upload test',
    help: [
      'Runs a three-part connection test against Cloudflare\'s edge and prints',
      'each result as it completes:',
      '',
      '  Latency    5 tiny requests → min / average / jitter',
      '  Download   a warm-up then a 10 MB transfer → Mbps',
      '  Upload     a 5 MB POST → Mbps',
      '',
      'All measurements run in your browser, so they reflect this device and',
      'network. Takes no arguments.',
    ],
    run: async (_args, { push }) => {
      const mbps = (bytes: number, secs: number) => ((bytes * 8) / secs / 1e6).toFixed(1);
      const CF = 'https://speed.cloudflare.com';
      let any = false;

      // ── Latency - several tiny requests; report min/avg/jitter ──
      push('Measuring latency…', 'info');
      try {
        const pings: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t = performance.now();
          await fetch(`${CF}/__down?bytes=0&_=${Date.now()}-${i}`, { cache: 'no-store' });
          pings.push(performance.now() - t);
        }
        const min = Math.min(...pings);
        const avg = pings.reduce((a, b) => a + b, 0) / pings.length;
        const jitter = Math.sqrt(pings.reduce((a, b) => a + (b - avg) ** 2, 0) / pings.length);
        push(`Latency   ${min.toFixed(0)} ms min · ${avg.toFixed(0)} ms avg · ${jitter.toFixed(0)} ms jitter  (${pings.length} samples)`);
        any = true;
      } catch { push('Latency   failed', 'error'); }

      // ── Download - warm up the connection, then time a real transfer ──
      push('Measuring download…', 'info');
      try {
        await fetch(`${CF}/__down?bytes=1000000`, { cache: 'no-store' }).then(r => r.arrayBuffer()); // warm-up
        const start = performance.now();
        const buf = await (await fetch(`${CF}/__down?bytes=10000000`, { cache: 'no-store' })).arrayBuffer();
        const secs = (performance.now() - start) / 1000;
        push(`Download  ${mbps(buf.byteLength, secs)} Mbps  (${(buf.byteLength / 1e6).toFixed(0)} MB in ${secs.toFixed(2)}s)`);
        any = true;
      } catch { push('Download  failed', 'error'); }

      // ── Upload - POST a chunk of data and time it ──
      push('Measuring upload…', 'info');
      try {
        const upBytes = 5_000_000;
        const start = performance.now();
        await fetch(`${CF}/__up`, { method: 'POST', body: new Uint8Array(upBytes), cache: 'no-store' });
        const secs = (performance.now() - start) / 1000;
        push(`Upload    ${mbps(upBytes, secs)} Mbps  (${(upBytes / 1e6).toFixed(0)} MB in ${secs.toFixed(2)}s)`);
        any = true;
      } catch { push('Upload    failed', 'error'); }

      return any ? 'Measured via speed.cloudflare.com' : 'Speed test failed - check your connection.';
    },
  },

  theme: {
    desc: 'Switch theme',
    usage: 'theme <dark|light|auto>',
    help: [
      'Switches the interface theme.',
      '',
      '  dark    Force the dark theme',
      '  light   Force the light theme',
      '  auto    Follow your system setting',
    ],
    run: (args, { theme, onSetTheme }) => {
      const target = args[0]?.toLowerCase() as 'dark' | 'light' | 'auto' | undefined;
      if (target !== 'dark' && target !== 'light' && target !== 'auto') {
        return 'Usage: theme <dark|light|auto>';
      }
      if (target !== 'auto' && theme === target) return `Already using ${target} theme.`;
      onSetTheme(target);
      return target === 'auto' ? 'Switched to auto (system) theme.' : `Switched to ${target} theme.`;
    },
  },

  folder: {
    desc: 'Switch folder',
    usage: 'folder <name>',
    help: [
      'Switches to a folder by name (case-insensitive; a unique prefix works).',
      '',
      '  name   The folder to open, e.g. News or "Reading List"',
      '',
      'Run with no name to list your folders. Use "add folder" to create one.',
    ],
    run: (args, { folders, onSelectFolder }) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        return ['Usage: folder <name>', 'Available: ' + folders.map(f => f.name).join(', ')];
      }
      const match = folders.find(f => f.name.toLowerCase() === name)
        ?? folders.find(f => f.name.toLowerCase().startsWith(name));
      if (!match) {
        return [`"${args.join(' ')}" not found.`, 'Available: ' + folders.map(f => f.name).join(', ')];
      }
      onSelectFolder(match.id);
      return `Switched to "${match.name}"`;
    },
  },
};

const CMD_NAMES = Object.keys(COMMANDS);

interface Props {
  folders: Folder[];
  theme: 'dark' | 'light';
  isAdmin: boolean;
  onSelectFolder: (id: string) => void;
  onCreateFolder: (name: string, color: string) => Promise<void>;
  onSetTheme: (t: 'dark' | 'light' | 'auto') => void;
  onRefreshFeeds: () => void;
  onAddSite: (payload: AddSitePayload) => Promise<void>;
  closing?: boolean;
  onClose: () => void;
}

let lineId = 0;
let persistedLines: Line[] = [{ id: lineId++, kind: 'info', text: 'Type "help" for available commands.' }];
let persistedHistory: string[] = [];

export default function Console({ folders, theme, isAdmin, onSelectFolder, onCreateFolder, onSetTheme, onRefreshFeeds, onAddSite, closing = false, onClose }: Props) {
  const [lines, setLines] = useState<Line[]>(persistedLines);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>(persistedHistory);
  const [histIdx, setHistIdx] = useState(-1);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<AddPending | null>(null);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only match on the first token and only when no space yet (still typing the command)
  const firstToken = input.split(/\s/)[0].toLowerCase();
  const suggestions = !pending && firstToken && !input.includes(' ')
    ? CMD_NAMES.filter(c => c.startsWith(firstToken) && c !== firstToken && (!COMMANDS[c].admin || isAdmin))
    : [];

  // Focus lands when the open animation finishes (see shell onAnimationEnd) so
  // the layout work focusing triggers can't contend with the first frames.
  // With reduced motion there's no animation, so focus immediately.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  // A running async command disables the input, which drops focus. When it
  // finishes, hand focus back so the next command can be typed straight away.
  // Skip the initial mount so this doesn't fight the open-animation focus.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (!running) inputRef.current?.focus();
  }, [running]);

  const push = useCallback((text: string | string[], kind: Line['kind'] = 'output') => {
    const texts = Array.isArray(text) ? text : [text];
    setLines(prev => {
      const next = [...prev, ...texts.map(t => ({ id: lineId++, kind, text: t }))];
      persistedLines = next;
      return next;
    });
  }, []);

  const folderLines = useCallback(
    () => folders.map((f, i) => `  ${i + 1}. ${f.name}`),
    [folders]
  );

  // Prompt-side folder resolver - accepts a 1-based number, an exact name, or a
  // unique name prefix
  const resolveFolder = useCallback((input: string): Folder | null => {
    const n = parseInt(input, 10);
    if (!isNaN(n) && n >= 1 && n <= folders.length) return folders[n - 1];
    const low = input.toLowerCase();
    return folders.find(f => f.name.toLowerCase() === low)
      ?? folders.find(f => f.name.toLowerCase().startsWith(low))
      ?? null;
  }, [folders]);

  const finishAdd = useCallback(async (d: AddData) => {
    const folder = folders.find(f => f.id === d.folderId);
    if (!folder || !d.domain) { push('Could not add the site.', 'error'); return; }
    const name = d.name || deriveName(d.domain);
    setRunning(true);
    try {
      await onAddSite({
        folderId: folder.id,
        domain: d.domain,
        name,
        faviconUrl: faviconUrl(d.domain),
        color: deriveColor(d.domain),
      });
      push(`Added ${d.domain} as "${name}" to ${folder.name}.`);
    } catch {
      push('Could not add the site - try again.', 'error');
    } finally {
      setRunning(false);
    }
  }, [folders, onAddSite, push]);

  // Collect the next missing field (domain → name → folder), or add once complete
  const proceedAdd = useCallback((d: AddData) => {
    const step = !d.domain ? 'domain' : !d.name ? 'name' : !d.folderId ? 'folder' : null;
    if (!step) { setPending(null); finishAdd(d); return; }
    setPending({ ...d, awaiting: step });
    if (step === 'domain') push('Enter a domain (e.g. example.com), or blank to cancel:', 'info');
    else if (step === 'name') push(`Name? Press enter for "${deriveName(d.domain!)}".`, 'info');
    else push(['Which folder? (name or number, blank to cancel)', ...folderLines()], 'info');
  }, [finishAdd, folderLines, push]);

  const startAddSite = useCallback((args: string[]) => {
    if (folders.length === 0) { push('No folders yet - use "add folder <name>" first.', 'error'); return; }
    // The domain is the first token that reads as one (has a dot, etc.)
    const domIdx = args.findIndex(a => parseDomain(a) !== null);
    let domain: string | undefined;
    let rest = args;
    if (domIdx >= 0) {
      domain = parseDomain(args[domIdx]) ?? undefined;
      rest = [...args.slice(0, domIdx), ...args.slice(domIdx + 1)];
    }
    // Folder = the longest trailing run of tokens that exactly names a folder;
    // whatever precedes it is the site name
    let folderId: string | undefined;
    let nameTokens = rest;
    for (let k = rest.length; k >= 1; k--) {
      const cand = rest.slice(rest.length - k).join(' ').toLowerCase();
      const f = folders.find(ff => ff.name.toLowerCase() === cand);
      if (f) { folderId = f.id; nameTokens = rest.slice(0, rest.length - k); break; }
    }
    const name = nameTokens.join(' ').trim() || undefined;
    proceedAdd({ domain, name, folderId });
  }, [folders, proceedAdd, push]);

  const createFolderFromArgs = useCallback(async (args: string[]) => {
    // A trailing #hex token is the color; everything before it is the name
    let tokens = args;
    let color: string | undefined;
    const last = tokens[tokens.length - 1];
    if (last && /^#[0-9a-fA-F]{3,8}$/.test(last)) { color = last; tokens = tokens.slice(0, -1); }
    const name = tokens.join(' ').trim();
    if (!name) { push('Usage: add folder <name> [#color]', 'error'); return; }
    if (name.length > 100) { push('Folder name must be 100 characters or fewer.', 'error'); return; }
    if (folders.some(f => f.name.toLowerCase() === name.toLowerCase())) {
      push(`A folder named "${name}" already exists.`, 'error'); return;
    }
    setRunning(true);
    try {
      await onCreateFolder(name, color ?? deriveColor(name));
      push(`Created folder "${name}" - switched to it.`);
    } catch {
      push('Could not create the folder - try again.', 'error');
    } finally {
      setRunning(false);
    }
  }, [folders, onCreateFolder, push]);

  // `add site …` / `add folder …`; a bare `add <domain> …` still adds a site
  const handleAdd = useCallback((args: string[]) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'folder') { createFolderFromArgs(args.slice(1)); return; }
    if (sub === 'site') { startAddSite(args.slice(1)); return; }
    startAddSite(args);
  }, [createFolderFromArgs, startAddSite]);

  // Feed a typed line into the active `add` flow
  const handlePendingAnswer = useCallback((raw: string, p: AddPending) => {
    const ans = raw.trim();
    if (ans.toLowerCase() === 'cancel') { setPending(null); push('Add cancelled.', 'info'); return; }
    const d: AddData = { domain: p.domain, name: p.name, folderId: p.folderId };

    if (p.awaiting === 'domain') {
      if (!ans) { setPending(null); push('Add cancelled.', 'info'); return; }
      const dom = parseDomain(ans);
      if (!dom) { push(`"${ans}" doesn't look like a domain - try again, or type "cancel".`, 'error'); return; }
      d.domain = dom;
    } else if (p.awaiting === 'name') {
      d.name = ans || deriveName(d.domain!);
    } else {
      if (!ans) { setPending(null); push('Add cancelled.', 'info'); return; }
      const f = resolveFolder(ans);
      if (!f) { push([`"${ans}" not found.`, ...folderLines()], 'error'); return; }
      d.folderId = f.id;
    }
    setPending(null);
    proceedAdd(d);
  }, [push, resolveFolder, folderLines, proceedAdd]);

  async function run(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed && !pending) return;

    push(`$ ${trimmed}`, 'input');
    setInput('');

    // A line typed mid-prompt answers the pending `add` flow, not a command
    if (pending) { handlePendingAnswer(trimmed, pending); return; }

    setHistory(h => {
      const next = [trimmed, ...h.filter(x => x !== trimmed)].slice(0, 50);
      persistedHistory = next;
      return next;
    });
    setHistIdx(-1);

    const [cmd, ...args] = trimmed.split(/\s+/);
    const key = cmd.toLowerCase();
    const def = COMMANDS[key];
    // Admin-only commands are treated as non-existent for everyone else, so the
    // console doesn't advertise capabilities the server would reject anyway.
    if (!def || (def.admin && !isAdmin)) {
      const hint = CMD_NAMES.find(c => c.startsWith(key[0]) && (!COMMANDS[c].admin || isAdmin));
      push(`Command not found: "${cmd}".${hint ? ` Did you mean "${hint}"?` : ' Type "help".'}`, 'error');
      return;
    }
    if (key === 'add') { handleAdd(args); return; }

    setRunning(true);
    try {
      const result = await def.run(args, { folders, theme, isAdmin, onSelectFolder, onSetTheme, onRefreshFeeds, push });
      if (result === '__CLEAR__') {
        persistedLines = [];
        setLines([]);
      } else {
        push(result);
      }
    } catch {
      push('An error occurred. Try again.', 'error');
    } finally {
      setRunning(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!running) run(input);
      return;
    }
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (suggestions.length === 1) {
        setInput(suggestions[0]);
      } else if (suggestions.length > 1) {
        setInput(suggestions[0]);
      } else if (firstToken && CMD_NAMES.includes(firstToken)) {
        // already a full command - do nothing
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(next);
      if (history[next] !== undefined) setInput(history[next]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.max(histIdx - 1, -1);
      setHistIdx(next);
      setInput(next === -1 ? '' : history[next]);
      return;
    }
  }

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      {/* The shell owns all motion (transform/opacity only - compositor-run,
          zero per-frame painting); the console inside is visually static */}
      <div
        className={`${styles.shell} ${closing ? styles.shellClosing : ''}`}
        onClick={e => e.stopPropagation()}
        onAnimationEnd={() => { if (!closing) inputRef.current?.focus(); }}
      >
      <div className={styles.console}>

        <div className={styles.header}>
          <span className={styles.headerTitle}>NEWT.AB CONSOLE</span>
          <span className={styles.headerHints}>
            <kbd>`</kbd>to close
            <span className={styles.dot}>·</span>
            <kbd>tab</kbd>to complete
            <span className={styles.dot}>·</span>
            <kbd>↑↓</kbd>history
          </span>
        </div>

        <div className={styles.outputArea} ref={outputRef} onClick={() => inputRef.current?.focus()}>
          {lines.map(line => (
            <div key={line.id} className={styles.line} data-kind={line.kind}>
              {line.text}
            </div>
          ))}
          {running && <div className={styles.line} data-kind="info">Running…</div>}
        </div>

        {suggestions.length > 0 && (
          <div className={styles.suggestions}>
            {suggestions.map(s => (
              <button
                key={s}
                className={styles.suggestion}
                onMouseDown={e => { e.preventDefault(); setInput(s); inputRef.current?.focus(); }}
              >
                <span className={styles.suggestionCmd}>{s}</span>
                <span className={styles.suggestionDesc}>{COMMANDS[s].desc}</span>
              </button>
            ))}
          </div>
        )}

        <div className={styles.inputRow}>
          <span className={styles.promptSymbol}>$</span>
          <input
            ref={inputRef}
            className={styles.textInput}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={running}
            placeholder={running ? '' : pending ? `enter ${pending.awaiting}…` : 'type a command…'}
          />
        </div>

      </div>
      </div>
    </div>
  );
}
