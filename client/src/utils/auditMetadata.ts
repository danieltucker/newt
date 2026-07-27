// Audit entries carry a `metadata` blob whose shape depends on the action:
// a before/after pair for a visibility change, a census of destroyed rows for
// an account deletion, a snippet for a removed comment. The admin table has one
// column for all of them, so this renders any of those shapes as a single
// readable line rather than raw JSON.
//
// Deliberately total: an unrecognised key still produces something, because a
// row written by a newer server must not render as a blank cell in an older
// client (or vice versa).

const MAX_LEN = 120;

// Keys whose values are noise in a one-line summary - either already shown in
// another column, or too long to be useful at this width.
const SKIP = new Set(['registeredAt', 'previouslyBannedAt', 'email']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// camelCase / snake_case → "camel case"
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value);
}

// A { from, to } pair is the one nested shape worth a dedicated rendering -
// it's the whole point of the entry for the three toggle actions.
function formatEntry(key: string, value: unknown): string | null {
  if (isRecord(value) && 'from' in value && 'to' in value) {
    return `${humanizeKey(key)} ${formatValue(value.from)} → ${formatValue(value.to)}`;
  }

  // A nested count map (the cascade census) - list only the non-zero parts,
  // since "0 folders" tells you nothing about what was destroyed.
  if (isRecord(value)) {
    const parts = Object.entries(value)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${v} ${humanizeKey(k)}`);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && value === 0) return null;

  // Bare strings (a snippet, an outcome) read better unlabelled
  if (typeof value === 'string') return value;

  return `${humanizeKey(key)} ${formatValue(value)}`;
}

export function summarizeMetadata(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata) return '-';

  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (SKIP.has(key)) continue;
    const part = formatEntry(key, value);
    if (part) parts.push(part);
  }

  if (parts.length === 0) return '-';
  const line = parts.join(' · ');
  return line.length > MAX_LEN ? line.slice(0, MAX_LEN - 1).trimEnd() + '…' : line;
}
