import type { Mark } from "../../types/content";

/**
 * Bare web addresses typed as text (footnotes and bibliographies imported
 * from DOCX keep them so) become links when the text is drawn: only http and
 * https, never stored, so the text, its marks and its diffs stay as they are.
 *
 * An address starts at `http://` or `https://` that does not continue a
 * word and runs to the next blank or to a character no address carries bare
 * (`<`, `>`, `"`, `«`, `»`, `“`, `”`). Punctuation that ends the sentence
 * around it is left out: a final `.`, `,`, `;`, `:`, `!`, `?`, `…` or `'`, and a
 * closing bracket the address did not open, as in "(véase https://x.org)".
 */
// The character before an address (or the start) is captured with it, so
// `findBareUrls` starts the range after it.
const BARE_URL = /(^|[^\p{L}\p{N}_])(https?:\/\/[^\s<>"«»“”]+)/giu;

/** Punctuation that ends a sentence, never an address. */
const TRAILING = /[.,;:!?'’…]$/u;

const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) if (c === char) total += 1;
  return total;
}

/** The address without the punctuation that closes the sentence around it. */
function trimUrl(url: string): string {
  let trimmed = url;
  for (;;) {
    if (TRAILING.test(trimmed)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    const last = trimmed.at(-1) ?? "";
    const opener = PAIRS[last];
    if (opener && count(trimmed, last) > count(trimmed, opener)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    return trimmed;
  }
}

/** The bare http and https addresses in `text`, as half-open ranges. */
export function findBareUrls(text: string): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  for (const match of text.matchAll(BARE_URL)) {
    const url = trimUrl(match[2]!);
    // Something after the scheme other than slashes: a host.
    if (!/^https?:\/\/[^/]/i.test(url)) continue;
    const from = match.index + match[1]!.length;
    found.push({ from, to: from + url.length });
  }
  return found;
}

/**
 * `marks` and a link mark over each bare address in `text` that no link or
 * formula already touches (a link keeps its own target; a formula's source
 * is LaTeX, not text), nor any of the `except` ranges. The same array when
 * there is none to add.
 */
export function withAutolinks(
  text: string,
  marks: Mark[],
  except: readonly { from: number; to: number }[] = [],
): Mark[] {
  if (!/https?:\/\//i.test(text)) return marks;
  const taken = [
    ...marks.filter((mark) => mark.type === "link" || mark.type === "formula"),
    ...except,
  ];
  const added: Mark[] = [];
  for (const { from, to } of findBareUrls(text)) {
    if (taken.some((mark) => mark.from < to && mark.to > from)) continue;
    added.push({ type: "link", from, to, href: text.slice(from, to) });
  }
  return added.length > 0 ? [...marks, ...added] : marks;
}
