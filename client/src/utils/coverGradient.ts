// A profile's cover strip: the banner behind the avatar on /u/<username>.
//
// It has three states, in priority order:
//
//   1. An uploaded image, stored as a site-relative /api/v1/images/<id> path.
//   2. A named gradient the owner picked from COVER_THEMES.
//   3. Nothing chosen — the colour is derived from the username instead:
//      deterministic, so a profile looks the same on every visit and to every
//      viewer, and spread across the hue wheel so two people's pages are told
//      apart at a glance.
//
// The theme table lives here rather than on the server, which stores whichever
// id it is given and validates only its shape. That keeps adding a gradient a
// one-line client change, and makes an id nobody recognises degrade to (3)
// rather than to a broken page.

export interface CoverStyle {
  /** Always the gradient, image or not - see coverStyle. */
  background: string;
  backgroundImage?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
  backgroundRepeat?: string;
}

/** Stable 32-bit hash. Same construction as deriveColor's, kept local so a
 *  palette change over there can't silently restyle every profile. */
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Base hue in [0, 360) for a username. Exported for tests and reuse. */
export function coverHue(username: string): number {
  return hash(username.toLowerCase()) % 360;
}

/** The auto gradient: a two-stop diagonal in related hues, derived from the name.
 *  +48° keeps the pair adjacent - a gradient, not a clash. */
function autoGradient(username: string): string {
  const h = coverHue(username);
  const h2 = (h + 48) % 360;
  return `linear-gradient(115deg, hsl(${h} 52% 58%) 0%, hsl(${h2} 58% 52%) 100%)`;
}

export interface CoverTheme {
  id: string;
  label: string;
  /** Undefined for 'auto', which needs the username to resolve. */
  gradient?: string;
}

// Deliberately muted and mid-toned: the strip sits directly behind the avatar
// and above the display name, and a vivid band there fights the content instead
// of framing it. Each is a two-stop diagonal, matching the auto gradient's
// geometry so a chosen theme and a derived one read as the same kind of thing.
export const COVER_AUTO = 'auto';

export const COVER_THEMES: CoverTheme[] = [
  { id: COVER_AUTO, label: 'Auto' },
  { id: 'dusk',    label: 'Dusk',    gradient: 'linear-gradient(115deg, hsl(248 52% 58%) 0%, hsl(296 58% 52%) 100%)' },
  { id: 'ember',   label: 'Ember',   gradient: 'linear-gradient(115deg, hsl(14 62% 57%) 0%, hsl(38 68% 54%) 100%)' },
  { id: 'moss',    label: 'Moss',    gradient: 'linear-gradient(115deg, hsl(146 38% 44%) 0%, hsl(178 42% 44%) 100%)' },
  { id: 'tide',    label: 'Tide',    gradient: 'linear-gradient(115deg, hsl(198 56% 52%) 0%, hsl(226 56% 56%) 100%)' },
  { id: 'orchid',  label: 'Orchid',  gradient: 'linear-gradient(115deg, hsl(318 48% 60%) 0%, hsl(266 52% 58%) 100%)' },
  { id: 'clay',    label: 'Clay',    gradient: 'linear-gradient(115deg, hsl(24 34% 52%) 0%, hsl(4 38% 50%) 100%)' },
  { id: 'slate',   label: 'Slate',   gradient: 'linear-gradient(115deg, hsl(214 16% 44%) 0%, hsl(232 20% 34%) 100%)' },
  { id: 'ink',     label: 'Ink',     gradient: 'linear-gradient(115deg, hsl(232 26% 26%) 0%, hsl(258 30% 20%) 100%)' },
];

/** The theme with this id, or undefined - including for 'auto', which has no
 *  fixed gradient of its own. */
export function coverThemeById(id: string | null | undefined): CoverTheme | undefined {
  if (!id) return undefined;
  return COVER_THEMES.find(t => t.id === id);
}

/** The gradient a theme paints for this user. Falls back to the derived one for
 *  'auto', for no theme at all, and for an id this build doesn't know. */
export function coverGradientFor(username: string, theme?: string | null): string {
  return coverThemeById(theme)?.gradient ?? autoGradient(username);
}

/**
 * An inline style for the cover strip. An uploaded image wins over any gradient,
 * but the gradient is kept underneath it: it is what shows while the image is
 * still loading, and what remains if it ever fails to.
 */
export function coverStyle(
  username: string,
  theme?: string | null,
  image?: string | null,
): CoverStyle {
  const gradient = coverGradientFor(username, theme);
  if (!image) return { background: gradient };
  // The path is server-validated to /api/v1/images/<id> (normalizeImagePath), so
  // it cannot carry a quote or a second url() out of the CSS string.
  return {
    background: gradient,
    backgroundImage: `url("${image}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  };
}
