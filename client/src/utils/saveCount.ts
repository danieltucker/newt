// How many people have kept an article, as a line of card metadata.
//
// The number used to be a badge on the Save pill, which put a fact about
// everyone else inside the control for what *you* do with the article. It reads
// as metadata - the same kind of thing as how long the piece takes - so it sits
// with the metadata now.
//
// Below ten it says "multiple saves" rather than the figure. Two and nine are
// the same fact to someone deciding whether to open something (other people
// kept this), and printing "3 saves" invites it to be read as a verdict on the
// article when it is mostly a statement about how long the article has been up.
// Ten is where a number starts carrying its own weight.
export const EXACT_FROM = 10;

/**
 * The label, or null when there is nothing worth saying.
 *
 * Nothing at zero: "0 saves" is a fact about an article nobody has got to yet,
 * not something to put on every new card in the river.
 *
 * One is still stated exactly. "Multiple" would be untrue, and folding it in
 * with zero would throw away the difference between one person and none - which
 * is the largest proportional step in the whole range.
 */
export function saveCountLabel(count: number | null | undefined): string | null {
  if (!count || !Number.isFinite(count) || count < 1) return null;
  if (count === 1) return '1 save';
  if (count < EXACT_FROM) return 'multiple saves';
  return `${count} saves`;
}
