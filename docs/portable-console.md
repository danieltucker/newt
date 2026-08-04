# Portable drop-in console

The Newt console as a self-contained React component you can carry into any project.
It has no external dependencies beyond React — commands are plugged in from the host app,
so none of the Newt-specific behavior comes along.

## How it works

**One component, one CSS module.** `Console.tsx` renders a full-screen overlay with a
terminal panel: header, scrollback output, autocomplete chip row, and an input row.
Everything is self-managed — the host only decides *when* it is mounted.

**Command registry.** A command is a name plus `{ desc, run }`. `run` receives the
argument tokens and returns a `string`, `string[]` (multiple lines), or a Promise of
either. Async commands show a `Running…` line and disable input until they settle.
`help` and `clear` are built in; the host passes its own commands as a prop and they
merge over the built-ins. Because commands are plain closures, they can capture
anything from the host (state setters, API clients) without the console knowing.

**Scrollback survives remounts.** Lines and history live in module-level variables
(`persistedLines`, `persistedHistory`) that the component state initializes from. Close
and reopen the console and your session is still there; refresh the page and it resets.
Deliberately not `localStorage` — a console session feels wrong persisting across days.

**Keyboard UX.** `Enter` runs, `Escape` closes, `Tab` completes the first suggestion,
`↑`/`↓` walk history (deduplicated, capped at 50). Suggestions only match while the
first token is being typed (no space yet), so argument text never triggers them.

**The open/close animation** runs entirely on the GPU compositor: the shell animates
only `transform` + `opacity`, and the liquid feel comes from squash-and-stretch
(`scaleY` overshoot and settle), not from morphing the shape. Two tempting
alternatives don't survive contact: animating `border-radius` repaints the panel and
its blurred shadows every frame (stutters on high-DPI/120Hz screens), and animating
`clip-path` slices through the 1px border while in flight so the border appears to
"draw in" at the end. Input focus is also deferred to `onAnimationEnd` so the layout
work focusing triggers can't contend with the animation's first frames.

**Mount/unmount choreography.** The host keeps two booleans: `open` and `closing`.
Opening mounts the component (enter animation plays automatically). Closing sets
`closing` (exit animation plays), and unmounts ~320ms later. The component itself never
unmounts; it just asks via `onClose`.

## Console.tsx

```tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './Console.module.css';

interface Line {
  id: number;
  kind: 'input' | 'output' | 'error' | 'info';
  text: string;
}

export type CommandResult = string | string[];
export type Command = {
  desc: string;
  run: (args: string[]) => CommandResult | Promise<CommandResult>;
};
export type Commands = Record<string, Command>;

export function col(name: string, desc: string): string {
  return `  ${name.padEnd(12)}${desc}`;
}

interface Props {
  commands: Commands;          // host commands, merged over the built-ins
  title?: string;
  greeting?: string;
  closing?: boolean;           // true while the exit animation should play
  onClose: () => void;
}

let lineId = 0;
let persistedLines: Line[] | null = null;
let persistedHistory: string[] = [];

export default function Console({
  commands,
  title = 'CONSOLE',
  greeting = 'Type "help" for available commands.',
  closing = false,
  onClose,
}: Props) {
  const all: Commands = {
    help: {
      desc: 'List available commands',
      run: () => Object.entries(all).map(([name, c]) => col(name, c.desc)),
    },
    clear: { desc: 'Clear the console', run: () => '__CLEAR__' },
    ...commands,
  };
  const names = Object.keys(all);

  const [lines, setLines] = useState<Line[]>(
    () => persistedLines ?? [{ id: lineId++, kind: 'info', text: greeting }]
  );
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>(persistedHistory);
  const [histIdx, setHistIdx] = useState(-1);
  const [running, setRunning] = useState(false);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const firstToken = input.split(/\s/)[0].toLowerCase();
  const suggestions = firstToken && !input.includes(' ')
    ? names.filter(c => c.startsWith(firstToken) && c !== firstToken)
    : [];

  // Focus lands when the open animation finishes (see shell onAnimationEnd);
  // with reduced motion there's no animation, so focus immediately
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      inputRef.current?.focus();
    }
  }, []);
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  const push = useCallback((text: CommandResult, kind: Line['kind'] = 'output') => {
    const texts = Array.isArray(text) ? text : [text];
    setLines(prev => {
      const next = [...prev, ...texts.map(t => ({ id: lineId++, kind, text: t }))];
      persistedLines = next;
      return next;
    });
  }, []);

  async function run(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    push(`$ ${trimmed}`, 'input');
    setHistory(h => {
      const next = [trimmed, ...h.filter(x => x !== trimmed)].slice(0, 50);
      persistedHistory = next;
      return next;
    });
    setHistIdx(-1);
    setInput('');

    const [cmd, ...args] = trimmed.split(/\s+/);
    const def = all[cmd.toLowerCase()];
    if (!def) {
      const hint = names.find(c => c.startsWith(cmd.toLowerCase()[0]));
      push(`Command not found: "${cmd}".${hint ? ` Did you mean "${hint}"?` : ' Type "help".'}`, 'error');
      return;
    }

    setRunning(true);
    try {
      const result = await def.run(args);
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
    if (e.key === 'Enter') { e.preventDefault(); if (!running) run(input); return; }
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (suggestions.length > 0) setInput(suggestions[0]);
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
      {/* The shell owns all motion (transform/opacity only — compositor-run,
          zero per-frame painting); the console inside is visually static */}
      <div
        className={`${styles.shell} ${closing ? styles.shellClosing : ''}`}
        onClick={e => e.stopPropagation()}
        onAnimationEnd={() => { if (!closing) inputRef.current?.focus(); }}
      >
      <div className={styles.console}>

        <div className={styles.header}>
          <span className={styles.headerTitle}>{title}</span>
          <span className={styles.headerHints}>
            <kbd>esc</kbd>to close
            <span className={styles.dot}>·</span>
            <kbd>tab</kbd>to complete
            <span className={styles.dot}>·</span>
            <kbd>↑↓</kbd>history
          </span>
        </div>

        <div className={styles.outputArea} ref={outputRef} onClick={() => inputRef.current?.focus()}>
          {lines.map(line => (
            <div key={line.id} className={styles.line} data-kind={line.kind}>{line.text}</div>
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
                <span className={styles.suggestionDesc}>{all[s].desc}</span>
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
            placeholder={running ? '' : 'type a command…'}
          />
        </div>

      </div>
      </div>
    </div>
  );
}
```

## Console.module.css

```css
.overlay {
  position: fixed;
  inset: 0;
  z-index: 1000; /* above everything in the host app */
  display: flex;
  align-items: flex-start;
  padding: 15px;
}

/* All motion lives on the shell as transform + opacity only — compositor-run,
   zero per-frame painting. The liquid feel is squash-and-stretch (scaleY
   overshoot and settle); don't morph border-radius (repaints every frame) or
   clip-path (slices the border while in flight). */
.shell {
  width: 100%;
  height: 42vh;
  min-height: 280px;
  border-radius: 10px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5), 0 16px 48px rgba(0, 0, 0, 0.6);
  transform-origin: top center;
  will-change: transform, opacity;
  animation: shellDown 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.console {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #0d1117;
  border: 1px solid #21262d;
  border-radius: 10px;
  overflow: hidden;
  font-family: 'IBM Plex Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
}

.shellClosing { animation: shellUp 0.32s cubic-bezier(0.6, 0, 0.8, 0.35) forwards; }

@keyframes shellDown {
  0%   { transform: translateY(-115%) scaleY(0.5); opacity: 0; }
  40%  { opacity: 1; }
  62%  { transform: translateY(7px) scaleY(1.04); }
  80%  { transform: translateY(-3px) scaleY(0.982); }
  92%  { transform: translateY(1px) scaleY(1.006); }
  100% { transform: translateY(0) scaleY(1); opacity: 1; }
}

@keyframes shellUp {
  0%   { transform: translateY(0) scaleY(1); opacity: 1; }
  22%  { transform: translateY(10px) scaleY(0.96); opacity: 1; }
  65%  { opacity: 0.5; }
  100% { transform: translateY(-115%) scaleY(0.5); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .shell, .shellClosing { animation: none; }
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #161b22;
  border-bottom: 1px solid #21262d;
  flex-shrink: 0;
}

.headerTitle {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #58a6ff;
}

.headerHints {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #484f58;
}

.headerHints kbd {
  font-family: inherit;
  font-size: 10px;
  color: #8b949e;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 1px 5px;
}

.dot { color: #30363d; }

/* ── Output area ── */
.outputArea {
  flex: 1;
  overflow-y: auto;
  padding: 10px 16px 4px;
  cursor: text;
  scrollbar-width: thin;
  scrollbar-color: #21262d transparent;
}

.outputArea::-webkit-scrollbar { width: 4px; }
.outputArea::-webkit-scrollbar-thumb { background: #21262d; border-radius: 2px; }

/* ── Lines ── */
.line {
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.line[data-kind="input"]  { color: #6e7681; margin-top: 10px; }
.line[data-kind="input"]:first-child { margin-top: 0; }
.line[data-kind="output"] { color: #e6edf3; }
.line[data-kind="error"]  { color: #f85149; }
.line[data-kind="info"]   { color: #3fb950; }

/* ── Autocomplete suggestions ── */
.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 16px;
  border-top: 1px solid #21262d;
  background: #0d1117;
  flex-shrink: 0;
}

.suggestion {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  border: 1px solid #21262d;
  border-radius: 5px;
  background: #161b22;
  cursor: pointer;
  transition: border-color 0.1s, background 0.1s;
}

.suggestion:hover {
  border-color: #58a6ff;
  background: #1c2333;
}

.suggestionCmd {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  color: #58a6ff;
}

.suggestionDesc {
  font-size: 11px;
  color: #484f58;
}

/* ── Input row ── */
.inputRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid #21262d;
  background: #0d1117;
  flex-shrink: 0;
}

.promptSymbol {
  color: #3fb950;
  font-weight: 700;
  user-select: none;
}

.textInput {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #e6edf3;
  font-family: inherit;
  font-size: inherit;
  caret-color: #58a6ff;
}

.textInput::placeholder { color: #484f58; }
.textInput:disabled { opacity: 0.5; }
```

## Host integration

```tsx
import { useState, useRef, useEffect } from 'react';
import Console, { Commands, col } from './Console';

function App() {
  const [showConsole, setShowConsole] = useState(false);
  const [consoleFading, setConsoleFading] = useState(false);
  const showRef = useRef(false);
  showRef.current = showConsole;
  const fadingRef = useRef(false);
  fadingRef.current = consoleFading;

  // Close = play the exit animation, then unmount after it finishes
  function closeConsole() {
    if (fadingRef.current) return;
    setConsoleFading(true);
    setTimeout(() => { setShowConsole(false); setConsoleFading(false); }, 320);
  }
  const closeRef = useRef(closeConsole);
  closeRef.current = closeConsole;

  // Backtick toggles, unless focus is in a text field
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        || (el instanceof HTMLElement && el.isContentEditable);
      if (typing && !showRef.current) return;
      if (e.code !== 'Backquote') return;
      e.preventDefault();
      if (showRef.current) closeRef.current();
      else setShowConsole(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Commands are plain closures — capture whatever app state you need
  const commands: Commands = {
    version: { desc: 'Show app version', run: () => 'MyApp v1.0.0' },
    echo: { desc: 'Echo the arguments', run: (args) => args.join(' ') || 'Usage: echo <text>' },
    fetch: {
      desc: 'GET a URL and show the status',
      run: async ([url]) => {
        if (!url) return 'Usage: fetch <url>';
        const r = await fetch(url);
        return `${r.status} ${r.statusText}`;
      },
    },
  };

  return (
    <>
      {/* …your app… */}
      {showConsole && (
        <Console
          commands={commands}
          title="MYAPP CONSOLE"
          closing={consoleFading}
          onClose={closeConsole}
        />
      )}
    </>
  );
}
```

## Notes when porting

- The 320ms unmount delay in `closeConsole` must match (or slightly under-run) the
  0.32s exit animation, or the console will pop out before the animation ends.
- The `__CLEAR__` sentinel is how the built-in `clear` empties scrollback; don't return
  that string from your own commands.
- Colors are hard-coded to a GitHub-dark palette so the console looks the same in any
  host theme. Swap the hex values (or replace them with your design tokens) to theme it.
- Commands that hit privileged endpoints (ping/traceroute in Newt) belong on your
  server behind auth — never shell out from anything reachable by unauthenticated users.
