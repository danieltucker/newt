// Serialize the caret position as a path of child indices from an editor root
// down to the anchor node, plus the offset. Because a history snapshot restores
// the exact same HTML, the same path resolves to the same spot - which is how
// undo/redo puts the caret back where it was.

export interface CaretPath {
  path: number[];
  offset: number;
}

export function getCaretPath(root: HTMLElement): CaretPath | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  let node: Node | null = range.startContainer;
  if (!root.contains(node)) return null;
  const path: number[] = [];
  while (node && node !== root) {
    const parent: Node | null = node.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return { path, offset: range.startOffset };
}

export function setCaretPath(root: HTMLElement, caret: CaretPath | null): void {
  if (!caret) return;
  let node: Node = root;
  for (const i of caret.path) {
    const child = node.childNodes[i];
    if (!child) break;   // structure diverged - land as close as we can
    node = child;
  }
  const doc = root.ownerDocument;
  const sel = doc.getSelection();
  if (!sel) return;
  const limit = node.nodeType === Node.TEXT_NODE
    ? (node.textContent ?? '').length
    : node.childNodes.length;
  const range = doc.createRange();
  try {
    range.setStart(node, Math.min(caret.offset, limit));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* node was rewritten out from under us - leave the caret be */
  }
}
