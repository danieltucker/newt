/**
 * Hiding something without moving the page under the reader.
 *
 * ── The problem ──
 * A card reserves space for its artwork before the artwork arrives - the hero
 * carries an `aspect-ratio`, so the row is the right height from the first
 * paint. When the picture then fails to load, the card hides it and gives that
 * space back. That is the correct end state: a card with no art has a layout of
 * its own, and a grey placeholder box would be worse than either.
 *
 * The trouble is *when* it happens. Artwork is `loading="lazy"`, so on a slow
 * connection an image resolves - or fails - seconds after its card was laid out,
 * by which time the reader has scrolled past it. Taking 170px out of a card
 * above the viewport slides everything below it up by 170px, and the article
 * being read jumps most of a screenful. It reads as the feed skipping content.
 *
 * ── Why the browser usually saves us, and when it doesn't ──
 * Scroll anchoring: the engine notices that content above the viewport changed
 * height and adjusts the scroll offset to hold the view still. Measured on this
 * feed at 430px, collapsing a 170px hero above the fold moves the card being
 * read by 0px in engines that anchor and 166px in engines that don't.
 *
 * Chrome and Firefox have had it for years. WebKit only gained it recently -
 * current Safari reports support and absorbs this correctly - but iOS versions
 * that predate it are long-lived and still a large share of real phones, and on
 * those the 166px is what the reader gets.
 *
 * So this is not a claim about "Safari". It is a claim about one capability,
 * asked for directly: `CSS.supports` tells us whether this engine knows the
 * property at all, which is exactly what differs. Where the engine anchors, this
 * does nothing and must do nothing - compensating on top of the browser's own
 * correction would double the jump instead of cancelling it.
 *
 * Only the part of the box that was *above* the viewport counts. Space removed
 * from below the fold moves nothing the reader can see, and a box straddling the
 * top edge only displaces by the part that was out of sight.
 */

const ANCHORS =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('overflow-anchor', 'auto')
    : false;

export function hideWithoutMovingThePage(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  el.style.display = 'none';
  if (ANCHORS) return;
  // How much of this box sat above the top of the viewport. `rect.top` is
  // negative for anything scrolled past, and the result is clamped to the box's
  // own height so a long-scrolled card can't ask for more back than it gave.
  const lost = Math.min(rect.height, Math.max(0, -rect.top));
  if (lost > 0) window.scrollBy(0, -lost);
}
