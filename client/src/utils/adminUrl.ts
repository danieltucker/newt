/**
 * /admin, /admin/<tab>, and /admin/reports/<id>.
 *
 * The same shape as the other parse*Path helpers: pathname only, no query
 * string, so App can match on it whole.
 *
 * The report id has its own address rather than riding in a prop because of
 * where it comes from: a report alert in the notification bell. That used to
 * hand the panel a `focusReportId` and open it, which meant the one screen a
 * moderator is sent to by a notification was the one screen they could not
 * link to, bookmark, or reopen after a reload.
 */

export type AdminTab =
  | 'overview' | 'users' | 'reports' | 'comments' | 'blog' | 'ai' | 'feeds' | 'errors' | 'audit';

/**
 * The four groups the nav offers, each holding one or more views.
 *
 * Sections are a *grouping*, not an address. A view keeps the address it always
 * had - /admin/users is still /admin/users, and /admin/reports/<id> is still the
 * way a report alert in the notification bell reaches one report. Which section
 * a view belongs to is derived from this table rather than written into the URL,
 * which is what lets the nav be reorganised without breaking a bookmark, a link
 * in somebody's notification history, or the deep link this file exists for.
 *
 * The grouping is by the job being done, not by the table being read:
 *
 *   Moderation  something needs judgement. Reports leads because it is the queue
 *               work arrives in; the other three are what you act on once a
 *               report sends you there, which is one workflow and used to be
 *               four unrelated nav rows.
 *   System      is the machinery working, and who changed what. Feeds and Errors
 *               are adjacent on purpose - the Errors table filters by a 'feed'
 *               source and the Feeds tab keeps its own refresh log, so feed
 *               failures were already being rendered twice under two nav rows
 *               with nothing to say they were the same events.
 *   Overview    and AI hold one view each. A section of one is not a wasted
 *               level: it is what keeps the top row four items wide, which is
 *               the width that survives a narrow window.
 */
export type AdminSection = 'overview' | 'moderation' | 'system' | 'ai';

export interface AdminSectionDef {
  id: AdminSection;
  label: string;
  /** In sub-nav order. The first is where picking the section lands you. */
  tabs: readonly AdminTab[];
}

export const ADMIN_SECTIONS: readonly AdminSectionDef[] = [
  { id: 'overview',   label: 'Overview',   tabs: ['overview'] },
  { id: 'moderation', label: 'Moderation', tabs: ['reports', 'users', 'comments', 'blog'] },
  { id: 'system',     label: 'System',     tabs: ['feeds', 'errors', 'audit'] },
  { id: 'ai',         label: 'AI',         tabs: ['ai'] },
];

export const ADMIN_PATH = '/admin';

/**
 * Every view, in nav order, derived from the sections rather than listed again.
 *
 * Two copies of an ordering is two things to keep in step, and the first entry
 * matters beyond tidiness: it is what a bare /admin resolves to.
 */
export const ADMIN_TABS: readonly AdminTab[] = ADMIN_SECTIONS.flatMap(s => [...s.tabs]);

/** Which section holds a view. Every view is in exactly one. */
export function sectionForTab(tab: AdminTab): AdminSection {
  return (ADMIN_SECTIONS.find(s => s.tabs.includes(tab)) ?? ADMIN_SECTIONS[0]).id;
}

/** The views in a section, in sub-nav order. */
export function tabsInSection(section: AdminSection): readonly AdminTab[] {
  return (ADMIN_SECTIONS.find(s => s.id === section) ?? ADMIN_SECTIONS[0]).tabs;
}

export function isAdminPath(path: string): boolean {
  return path === ADMIN_PATH || path.startsWith(`${ADMIN_PATH}/`);
}

/**
 * The tab named by /admin/<tab>, or null.
 *
 * Null covers the bare index and an unrecognised name alike, on purpose - the
 * same bargain settingsUrl makes. A retired tab name in somebody's bookmark
 * should still open the console rather than 404, and "no tab named" is a state
 * the page already renders: the tab list on a phone, the first tab on a wide
 * screen.
 *
 * /admin/reports/<id> resolves to `reports`, because that is the tab it is a
 * view of.
 */
export function parseAdminTab(path: string): AdminTab | null {
  const match = path.match(/^\/admin\/([^/]+)(?:\/[^/]+)?\/?$/);
  if (!match) return null;
  const name = decodeURIComponent(match[1]).toLowerCase() as AdminTab;
  return ADMIN_TABS.includes(name) ? name : null;
}

/**
 * The report id in /admin/reports/<id>, or null.
 *
 * Only ever under `reports`: /admin/users/<id> is not a thing, and reading an
 * id out of it would be inventing a route the console does not serve.
 */
export function parseAdminReportId(path: string): string | null {
  const match = path.match(/^\/admin\/reports\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The address of a tab, and optionally of one report inside Reports. */
export function adminPathFor(tab?: AdminTab | null, reportId?: string | null): string {
  if (reportId) return `${ADMIN_PATH}/reports/${encodeURIComponent(reportId)}`;
  return tab ? `${ADMIN_PATH}/${tab}` : ADMIN_PATH;
}
