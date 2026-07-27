// A profile's cover strip. There's no uploaded banner in the data model, so the
// colour is derived from the username instead - deterministic, so a profile
// looks the same on every visit and to every viewer, and spread across the hue
// wheel so two people's pages are told apart at a glance.
//
// Hue only: saturation and lightness are fixed and deliberately muted, because
// the strip sits directly behind the avatar and above the display name, and a
// vivid band there fights the content instead of framing it.

export interface CoverStyle {
  background: string;
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

/** An inline style for the cover strip: a two-stop diagonal in related hues. */
export function coverStyle(username: string): CoverStyle {
  const h = coverHue(username);
  // +48° keeps the pair adjacent - a gradient, not a clash.
  const h2 = (h + 48) % 360;
  return {
    background:
      `linear-gradient(115deg, hsl(${h} 52% 58%) 0%, hsl(${h2} 58% 52%) 100%)`,
  };
}
