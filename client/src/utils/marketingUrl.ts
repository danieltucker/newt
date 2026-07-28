// Routing helpers for the public marketing pages: the six section pages at
// /features/<slug> and the self-hosting page at /self-hosting.
//
// These are the only routes that render the same for a signed-out visitor and a
// signed-in one, so App.tsx matches them ahead of the auth split.

import { SECTION_BY_SLUG, type Section } from '../marketing/sections';

export const SELF_HOST_PATH = '/self-hosting';
const FEATURES_PREFIX = '/features/';

export function featurePathFor(slug: string): string {
  return `${FEATURES_PREFIX}${slug}`;
}

// The section a /features/<slug> path names, or null - both for a path that
// isn't a feature page at all and for a slug that names no section, so an old or
// mistyped link falls through to whatever the router would otherwise have shown.
export function parseFeaturePath(pathname: string): Section | null {
  if (!pathname.startsWith(FEATURES_PREFIX)) return null;
  const slug = pathname.slice(FEATURES_PREFIX.length).replace(/\/+$/, '');
  if (!slug || slug.includes('/')) return null;
  return SECTION_BY_SLUG[slug] ?? null;
}

export function isSelfHostPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === SELF_HOST_PATH;
}
