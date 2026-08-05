import { ReadingListItem } from '../types';

// How long the pile is. Shared by the reading list itself and by the launcher
// that stands in front of it on the new tab, which have to agree - the whole
// point of the launcher is that the number on it is the number you find inside.

// Manually saved articles often have no read time; assume a middling article so
// the total still means something.
export const DEFAULT_MINUTES = 5;

export function totalMinutes(items: ReadingListItem[]): number {
  return items.reduce((sum, i) => sum + (parseInt(i.readTime, 10) || DEFAULT_MINUTES), 0);
}

export function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m ? `${hours} ${m} min` : hours;
}

// A shorter form for tight spaces - the launcher's stat line, where "1 hour
// 20 min" has to sit beside a count and a label on a phone.
export function shortDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
