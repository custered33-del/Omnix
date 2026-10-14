/**
 * Bridge between contentEditable rich text and the inline markdown stored in blocks
 * (**bold**, *italic*, ~~strike~~, `code`, [link](url)). Text is escaped so characters
 * people type never turn into formatting by accident.
 */

const ESCAPE = /([\\*_`~[\]])/g;

type Mark = 'b' | 'i' | 's' | 'code' | 'a';

function markOf(el: Element): Mark | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'b' || tag === 'strong') return 'b';
  if (tag === 'i' || tag === 'em') return 'i';
  if (tag === 's' || tag === 'strike' || tag === 'del') return 's';
  if (tag === 'code') return 'code';
  if (tag === 'a') return 'a';
  if (tag === 'span') {
    const st = (el as HTMLElement).style;
    if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) return 'b';
    if (st.fontStyle === 'italic') return 'i';
    if (st.textDecoration.includes('line-through')) return 's';
  }
  return null;
}

function wrap(mark: Mark, inner: string, el?: Element): string {
  if (!inner) return '';
  // Keep whitespace outside the markers so "**bold **" never appears.
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner)![0];
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (!core) return inner;
  switch (mark) {
    case 'b':
      return `${lead}**${core}**${trail}`;
    case 'i':
      return `${lead}*${core}*${trail}`;
    case 's':
      return `${lead}~~${core}~~${trail}`;
    case 'code':
      return `${lead}\`${core.replace(/\\([\\*_`~[\]])/g, '$1').replace(/`/g, '')}\`${trail}`;
    case 'a': {
      const href = (el as HTMLAnchorElement | undefined)?.getAttribute('href') ?? '';
      return href ? `${lead}[${core}](${href.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20'))})${trail}` : inner;
    }
  }
}

function serialize(nodes: ArrayLike<ChildNode>): string {
  let out = '';
  // Merge runs of siblings with the same mark (execCommand often splits them).
  let i = 0;
  const list = Array.from(nodes);
  while (i < list.length) {
    const n = list[i]!;
    if (n.nodeType === Node.TEXT_NODE) {
      out += (n.textContent ?? '').replace(/ /g, ' ').replace(ESCAPE, '\\$1');
      i++;
      continue;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) {
      i++;
      continue;
    }
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      out += ' ';
      i++;
      continue;
    }
    const mark = markOf(el);
    if (mark === 'a') {
      // One link even when formatting split it into several anchors.
      const href = el.getAttribute('href');
      let inner = serialize(el.childNodes);
      let j = i + 1;
      while (j < list.length && list[j]!.nodeType === Node.ELEMENT_NODE && (list[j] as Element).tagName.toLowerCase() === 'a' && (list[j] as Element).getAttribute('href') === href) {
        inner += serialize((list[j] as Element).childNodes);
        j++;
      }
      out += wrap('a', inner, el);
      i = j;
      continue;
    }
    if (!mark) {
      out += serialize(el.childNodes);
      if (tag === 'div' || tag === 'p') out += ' ';
      i++;
      continue;
    }
    let inner = serialize(el.childNodes);
    let j = i + 1;
    while (j < list.length && list[j]!.nodeType === Node.ELEMENT_NODE && markOf(list[j] as Element) === mark) {
      inner += serialize((list[j] as Element).childNodes);
      j++;
    }
    out += wrap(mark, inner);
    i = j;
  }
  return out;
}

/** Inline markdown for the contents of a contentEditable element. */
export function domToInline(el: Node): string {
  return serialize(el.childNodes).replace(/\s+$/g, (m) => (m.includes('\n') ? '' : m)).replace(/ {2,}/g, ' ');
}

/** Inline markdown for a DOM fragment (used when splitting a block at the caret). */
export function fragmentToInline(frag: DocumentFragment): string {
  const div = document.createElement('div');
  div.appendChild(frag);
  return domToInline(div);
}

/** Caret position as a plain-text character offset inside `root` (null when outside). */
export function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

/** Selected plain-text range inside `root`. */
export function selectionRange(root: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return [start, start + r.toString().length];
}

/** Put the caret at a plain-text offset inside `root` (clamped to the end). */
export function setCaret(root: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode() as Text | null;
  let last: Text | null = null;
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const r = document.createRange();
      r.setStart(node, remaining);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    remaining -= len;
    last = node;
    node = walker.nextNode() as Text | null;
  }
  const r = document.createRange();
  if (last) r.setStart(last, last.textContent?.length ?? 0);
  else r.setStart(root, root.childNodes.length);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** True when the caret is on the first (or last) visual line of the element. */
export function caretOnEdgeLine(root: HTMLElement, edge: 'top' | 'bottom'): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return true;
  const r = sel.getRangeAt(0).cloneRange();
  const rects = r.getClientRects();
  const box = root.getBoundingClientRect();
  const rect = rects[0] ?? (r.startContainer instanceof Element ? r.startContainer.getBoundingClientRect() : null);
  if (!rect || (rect.top === 0 && rect.bottom === 0)) {
    const off = caretOffset(root) ?? 0;
    return edge === 'top' ? off === 0 : off >= (root.textContent?.length ?? 0);
  }
  const lh = parseFloat(getComputedStyle(root).lineHeight) || 20;
  return edge === 'top' ? rect.top - box.top < lh * 0.8 : box.bottom - rect.bottom < lh * 0.8;
}

/** Split the element at the caret: returns markdown before and after, leaving the DOM untouched. */
export function splitAtCaret(root: HTMLElement): { before: string; after: string } {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.getRangeAt(0).endContainer)) return { before: domToInline(root), after: '' };
  const r = sel.getRangeAt(0);
  const tail = document.createRange();
  tail.setStart(r.endContainer, r.endOffset);
  tail.setEnd(root, root.childNodes.length);
  const afterFrag = tail.cloneContents();
  const head = document.createRange();
  head.setStart(root, 0);
  head.setEnd(r.startContainer, r.startOffset);
  const beforeFrag = head.cloneContents();
  return { before: fragmentToInline(beforeFrag), after: fragmentToInline(afterFrag) };
}
