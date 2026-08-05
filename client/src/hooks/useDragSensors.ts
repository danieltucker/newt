import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';

/**
 * The sensor set every sortable in the app uses.
 *
 * ── Why not PointerSensor ──
 * PointerSensor treats a mouse and a finger as the same input, and they don't
 * want the same activation gesture. Its only signal is a movement threshold,
 * and the thresholds here were mouse-sized (6-8px) - which a thumb tapping a
 * bookmark clears without meaning to, while a mouse click never does.
 *
 * The concrete cost was scrolling. A pointermove cannot be preventDefault-ed
 * into not scrolling the page, so the only way to keep the page still under a
 * drag was `touch-action: none` on the draggable - which is what the folder
 * rows and the notes columns carried, and which meant a swipe that began on one
 * of them scrolled nothing at all. Those declarations are gone with this.
 *
 * ── What replaces it ──
 * Two sensors, each with the gesture that suits its input:
 *
 *   - Mouse keeps the movement threshold. A click is still a click.
 *   - Touch requires a press-and-hold. `tolerance` is the give allowed during
 *     that hold: move further before the delay is up and the drag is abandoned,
 *     the page scrolls, and the tap stays a tap. So a scroll is a scroll and
 *     only a deliberate hold picks anything up - the bargain every touch UI
 *     makes for reordering.
 *
 * TouchSensor listens to touch events rather than pointer events for exactly
 * that reason: touchmove *can* be prevented, so once a drag has really started
 * the page underneath holds still without needing `touch-action: none`.
 *
 * @param distance Mouse travel, in px, that starts a drag.
 */
export function useDragSensors(distance = 8) {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );
}
