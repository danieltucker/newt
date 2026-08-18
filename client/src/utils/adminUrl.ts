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

export const ADMIN_PATH = '/admin';

/**
 * In the order the console's nav lists them, which also makes the first entry
 * what a bare /admin resolves to on a wide screen. AdminPage builds its nav
 * from this rather than keeping a second copy of the order.
 */
export const ADMIN_TABS: readonly AdminTab[] = [
  'overview', 'users', 'reports', 'comments', 'blog', 'ai', 'feeds', 'errors', 'audit',
];

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
