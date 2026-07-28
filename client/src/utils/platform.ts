// Which modifier key this machine calls "the command key".
//
// Handlers should keep accepting either Ctrl or Meta - that is what the editor
// already does for Ctrl+Z, and a Mac user pressing Ctrl+B still means bold.
// This is only for *labelling*: a hint that reads "Ctrl+F" on a Mac is telling
// the user to press a key they are not reaching for.

function detect(): boolean {
  if (typeof navigator === 'undefined') return false;
  // userAgentData is the non-deprecated source where it exists; the platform
  // string is the fallback everywhere else. iPadOS reports MacIntel, which is
  // the answer we want anyway - it has a Command key.
  const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = ua.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export const IS_MAC = detect();

/** The command-key symbol for this platform: "⌘" on a Mac, "Ctrl" elsewhere. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Label a Ctrl/Cmd shortcut the way the local keyboard prints it - `modLabel('F')`
 * gives "⌘F" on a Mac and "Ctrl+F" everywhere else.
 */
export function modLabel(key: string): string {
  return IS_MAC ? `${MOD_KEY}${key}` : `${MOD_KEY}+${key}`;
}
