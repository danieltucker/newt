/**
 * /settings and /settings/<section>, with a #anchor for one setting.
 *
 * The same shape as the other parse*Path helpers: pathname only, no query
 * string, so App can match on it whole.
 *
 * A single setting rides in the hash rather than a query parameter because it
 * names a place on the page rather than an instruction to it. That is what
 * makes the `data-setting` anchors on the blocks themselves into addresses
 * worth pasting: /settings/reading#comments-sort lands on the switch itself
 * rather than on the section that happens to contain it, which for Reading is
 * a long scroll.
 *
 * The settings search used to be the thing that produced these, and it is gone.
 * The anchors are not: nothing inside the page emits one now, but a pasted or
 * bookmarked address still lands, which is the half of this that was ever worth
 * having.
 */

export type SettingsSection =
  | 'account' | 'search' | 'appearance' | 'reading' | 'ai' | 'advanced';

export const SETTINGS_PATH = '/settings';

/**
 * The five groups the nav offers, each holding one or more sections.
 *
 * The same arrangement, and the same reasoning, as ADMIN_SECTIONS next door: a
 * group is a *grouping*, not an address. A section keeps the address it always
 * had, so /settings/appearance is still /settings/appearance and
 * /settings/reading#comments-sort still lands on the switch it names. Which
 * group a section belongs to is derived from this table rather than written
 * into the URL, which is what lets the nav be reorganised without breaking a
 * bookmark or a link somebody pasted.
 *
 * Seven rail rows became five groups, grouped by the job being done rather than
 * by where the setting happens to be stored:
 *
 *   New tab      what the page a new tab opens onto looks like, and what the
 *                search box on it does. Appearance and Search were two rows for
 *                one screen - the theme, the background and the bookmarks are
 *                that screen, and so is the field in the middle of it.
 *   Advanced     took Integrations whole. Between them they held four blocks -
 *                the console switch, the bookmark importer, the friends' feed
 *                URL and the bookmarklets - and "advanced" versus "integrations"
 *                is not a distinction anybody was navigating by. One short
 *                section now, rather than two shorter ones.
 *   Account,     one section each. A group of one is not a wasted level: it is
 *   Reading,     what keeps the top row five items wide, which is the width
 *   AI           that survives a narrow window.
 */
export type SettingsGroup = 'account' | 'newtab' | 'reading' | 'ai' | 'advanced';

export interface SettingsGroupDef {
  id: SettingsGroup;
  label: string;
  /** In sub-nav order. The first is where picking the group lands you. */
  sections: readonly SettingsSection[];
}

export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: 'account',  label: 'Account',  sections: ['account'] },
  { id: 'newtab',   label: 'New tab',  sections: ['appearance', 'search'] },
  { id: 'reading',  label: 'Reading',  sections: ['reading'] },
  { id: 'ai',       label: 'AI',       sections: ['ai'] },
  { id: 'advanced', label: 'Advanced', sections: ['advanced'] },
];

/**
 * Every section, in nav order, derived from the groups rather than listed again.
 *
 * Two copies of an ordering is two things to keep in step, and the first entry
 * matters beyond tidiness: it is what a bare /settings resolves to.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] =
  SETTINGS_GROUPS.flatMap(g => [...g.sections]);

/** Which group holds a section. Every section is in exactly one. */
export function groupForSection(section: SettingsSection): SettingsGroup {
  return (SETTINGS_GROUPS.find(g => g.sections.includes(section)) ?? SETTINGS_GROUPS[0]).id;
}

/** The sections in a group, in sub-nav order. */
export function sectionsInGroup(group: SettingsGroup): readonly SettingsSection[] {
  return (SETTINGS_GROUPS.find(g => g.id === group) ?? SETTINGS_GROUPS[0]).sections;
}

/**
 * Section names that used to exist, and where their contents went.
 *
 * Retiring a section is not the same as retiring its settings: Integrations was
 * folded into Advanced and every block inside it came along, anchors and all.
 * So /settings/integrations#bookmarklets still has somewhere exact to land, and
 * dropping it to the bare index the way an unrecognised name is dropped would
 * throw away a working link for nothing.
 */
const RETIRED_SECTIONS: Readonly<Record<string, SettingsSection>> = {
  integrations: 'advanced',
};

export function isSettingsPath(path: string): boolean {
  return path === SETTINGS_PATH || path.startsWith(`${SETTINGS_PATH}/`);
}

/**
 * The section named by /settings/<section>, or null.
 *
 * Null covers the bare index and an unrecognised name alike, on purpose. A
 * mistyped section name should still open settings rather than 404, and "no
 * section named" is a state the page already renders - it lands on the first
 * section.
 *
 * A *retired* name is different from a mistyped one and is answered above, in
 * RETIRED_SECTIONS: it had real settings under it and they are still somewhere,
 * so it resolves there instead of falling to the index.
 */
export function parseSettingsSection(path: string): SettingsSection | null {
  const match = path.match(/^\/settings\/([^/]+)\/?$/);
  if (!match) return null;
  const name = decodeURIComponent(match[1]).toLowerCase() as SettingsSection;
  if (SETTINGS_SECTIONS.includes(name)) return name;
  return RETIRED_SECTIONS[name] ?? null;
}

/** The address of a section, and optionally of one setting inside it. */
export function settingsPathFor(section?: SettingsSection | null, anchor?: string | null): string {
  const base = section ? `${SETTINGS_PATH}/${section}` : SETTINGS_PATH;
  return anchor ? `${base}#${anchor}` : base;
}
