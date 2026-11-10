import { isSafeHref } from "~~/shared/utils/content/render";

/**
 * Which addresses the editor turns into a link. Content keeps only http,
 * https and mailto links (`isSafeHref`); anything else would look like a link
 * while editing and be dropped when the text is read, so the editor never
 * makes it one: typed, pasted or set in the link dialog.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/;
/** A host with a dot, written without its scheme (`creup.es/normativa`). */
const BARE_HOST = /^[^\s/:?#@]+\.[^\s/:?#@]+([/?#]\S*)?$/;

/** The address as it is stored: an email gets `mailto:`, a bare host `https://`. */
export function normalizeHref(value: string): string {
  const href = value.trim();
  if (!href || SCHEME.test(href)) return href;
  if (EMAIL.test(href)) return `mailto:${href}`;
  return `https://${href}`;
}

/**
 * The link extension's `isAllowedUri`. It gets a full address (a pasted
 * anchor, the link dialog) or the text found while typing or pasting, which
 * may come without a scheme and gets one then (`https://`, or `mailto:` for
 * an email). With a scheme only the safe ones pass; without one, only a bare
 * host or an email, never a relative path.
 */
export function isEditorLinkAllowed(value: string | undefined): boolean {
  const href = (value ?? "").trim();
  if (!href) return false;
  if (SCHEME.test(href)) return isSafeHref(href);
  return EMAIL.test(href) || BARE_HOST.test(href);
}

/**
 * Pasted HTML without the anchors whose address content would not keep:
 * their text stays, as plain text. Anchors with a safe address are untouched.
 */
export function stripUnsafeLinks(html: string): string {
  if (!/<a\b/i.test(html)) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  parsed.body.querySelectorAll("a[href]").forEach((anchor) => {
    if (isSafeHref(anchor.getAttribute("href") ?? undefined)) return;
    anchor.replaceWith(...Array.from(anchor.childNodes));
    changed = true;
  });
  return changed ? parsed.body.innerHTML : html;
}
