/**
 * /settings and /settings/<section>, with a #anchor for one setting.
 *
 * The same shape as the other parse*Path helpers: pathname only, no query
 * string, so App can match on it whole.
 *
 * A single setting rides in the hash rather than a query parameter because it
 * names a place on the page rather than an instruction to it. That is what
 * turns the anchors the settings search already knows about into addresses
 * worth pasting: /settings/reading#comments-sort lands on the switch itself
 * rather than on the section that happens to contain it, which for Reading is
 * a long scroll.
 */

export type SettingsSection =
  | 'account' | 'search' | 'appearance' | 'reading' | 'ai' | 'advanced' | 'integrations';

export const SETTINGS_PATH = '/settings';

/**
 * In the order the section rail lists them, which also makes the first entry
 * what a bare /settings resolves to on a wide screen. SettingsPage builds its
 * rail from this rather than keeping a second copy of the order.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'account', 'search', 'appearance', 'reading', 'ai', 'advanced', 'integrations',
];

export function isSettingsPath(path: string): boolean {
  return path === SETTINGS_PATH || path.startsWith(`${SETTINGS_PATH}/`);
}

/**
 * The section named by /settings/<section>, or null.
 *
 * Null covers the bare index and an unrecognised name alike, on purpose. A
 * mistyped or retired section name should still open settings rather than
 * 404, and "no section named" is a state the page already renders: the section
 * list on a phone, the first section on a wide screen.
 */
export function parseSettingsSection(path: string): SettingsSection | null {
  const match = path.match(/^\/settings\/([^/]+)\/?$/);
  if (!match) return null;
  const name = decodeURIComponent(match[1]).toLowerCase() as SettingsSection;
  return SETTINGS_SECTIONS.includes(name) ? name : null;
}

/** The address of a section, and optionally of one setting inside it. */
export function settingsPathFor(section?: SettingsSection | null, anchor?: string | null): string {
  const base = section ? `${SETTINGS_PATH}/${section}` : SETTINGS_PATH;
  return anchor ? `${base}#${anchor}` : base;
}
