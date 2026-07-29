// The links a profile shows out to the rest of the web.
//
// The table below is presentation only: it supplies a label, a suggested host
// and an example so the settings form can say "bsky.app/profile/you" instead of
// "URL". The server keeps no copy of it (see lib/profileLinks.ts) - it stores
// whatever platform id it is given, so a link saved on a newer build renders on
// an older one as a generic site rather than disappearing.
//
// Icons are favicons, fetched through our own /api/v1/util/favicon proxy exactly
// as bookmark tiles are. That is what makes "and other common ones" work: any
// site a person can link to arrives with its own mark, and nothing here has to
// be updated when a service rebrands.

import { faviconUrl, parseDomain } from './color';

export interface LinkPlatform {
  id: string;
  label: string;
  /** The host a bare handle is completed against, and the favicon's source when
   *  the URL itself has none. Empty for 'website', which has no fixed host. */
  host: string;
  /** Shown under the URL field as the shape of a link to this service. */
  example: string;
}

export const WEBSITE_PLATFORM = 'website';

export const LINK_PLATFORMS: LinkPlatform[] = [
  { id: 'bluesky',   label: 'Bluesky',   host: 'bsky.app',        example: 'bsky.app/profile/you' },
  { id: 'instagram', label: 'Instagram', host: 'instagram.com',   example: 'instagram.com/you' },
  { id: 'facebook',  label: 'Facebook',  host: 'facebook.com',    example: 'facebook.com/you' },
  { id: 'linkedin',  label: 'LinkedIn',  host: 'linkedin.com',    example: 'linkedin.com/in/you' },
  { id: 'github',    label: 'GitHub',    host: 'github.com',      example: 'github.com/you' },
  { id: 'mastodon',  label: 'Mastodon',  host: 'mastodon.social', example: 'mastodon.social/@you' },
  { id: 'x',         label: 'X',         host: 'x.com',           example: 'x.com/you' },
  { id: 'threads',   label: 'Threads',   host: 'threads.net',     example: 'threads.net/@you' },
  { id: 'youtube',   label: 'YouTube',   host: 'youtube.com',     example: 'youtube.com/@you' },
  { id: 'twitch',    label: 'Twitch',    host: 'twitch.tv',       example: 'twitch.tv/you' },
  { id: 'reddit',    label: 'Reddit',    host: 'reddit.com',      example: 'reddit.com/user/you' },
  { id: 'substack',  label: 'Substack',  host: 'substack.com',    example: 'you.substack.com' },
  { id: WEBSITE_PLATFORM, label: 'Website', host: '', example: 'example.com' },
];

export interface ProfileLink {
  platform: string;
  url: string;
}

export function platformOf(id: string): LinkPlatform | undefined {
  return LINK_PLATFORMS.find(p => p.id === id);
}

/** Mirrors MAX_PROFILE_LINKS on the server - the form stops offering Add rather
 *  than letting a save fail. */
export const MAX_PROFILE_LINKS = 8;

/**
 * What the owner typed, as a URL the server will accept - or null.
 *
 * Bare hosts are the normal case ("github.com/sam"), so a missing scheme is
 * filled in rather than rejected; everything else follows the server's rule in
 * lib/profileLinks.ts, so the form can refuse a bad link before the round trip
 * instead of surfacing a 400.
 */
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A scheme we don't want is rejected here rather than being prefixed into
  // something that looks safe: "https://javascript:alert(1)" must not be built.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!parsed.hostname.includes('.')) return null;
  const href = parsed.toString();
  return href.length <= 300 ? href : null;
}

/** The platform whose host this URL sits on, or 'website'. Lets the form guess
 *  when someone pastes a link before picking a service. */
export function guessPlatform(url: string): string {
  const host = parseDomain(url) ?? '';
  if (!host) return WEBSITE_PLATFORM;
  const match = LINK_PLATFORMS.find(p =>
    p.host && (host === p.host || host.endsWith(`.${p.host}`)));
  return match?.id ?? WEBSITE_PLATFORM;
}

/** The host, without www or a path - what a link is captioned with when there is
 *  no known platform to name it. */
export function linkHost(url: string): string {
  return parseDomain(url) ?? url;
}

/** Screen-reader and tooltip text: the service's name where we know it, the host
 *  otherwise. */
export function linkLabel(link: ProfileLink): string {
  return platformOf(link.platform)?.label ?? linkHost(link.url);
}

/** The icon for a link. Taken from the URL's own host, so a Mastodon link on
 *  someone's own instance shows that instance's mark. */
export function linkIcon(link: ProfileLink): string {
  const host = parseDomain(link.url) ?? platformOf(link.platform)?.host ?? '';
  return host ? faviconUrl(host) : '';
}
