import type { InjectionKey } from "vue";
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";

/**
 * What a code of another amendment needs to be a link with a preview
 * (AmendmentCodeLinks, user's decision of 2026-11-20): the page that shows
 * such codes provides it (the document page, the session console, the
 * control sheet, Validación…), so clicking UEX2 in «Sustituye a 2 · UEX2»
 * shows what it changes and, from there, goes to it. Without it, the codes
 * read as plain text.
 */
export interface AmendmentLinksContext {
  /** The amendment, if the reader has it. */
  get: (id: string) => AmendmentDto | undefined;
  /**
   * Opens that amendment where it makes sense on the page (the document's
   * panel, the document page…). Without it the code only previews.
   */
  open?: (id: string) => void;
  /**
   * The text of the document the amendment changes, for the preview's
   * diff; null when the page does not have it (the preview then names it
   * without the diff).
   */
  baseOf: (id: string) => Block[] | null;
  /**
   * The page already previews amendments in a window of its own (the
   * control sheet, En directo): a code opens that window instead of a
   * preview of its own, so there is one preview, not two (user's decision
   * of 2026-11-20).
   */
  inWindow?: boolean;
}

export const AMENDMENT_LINKS_KEY: InjectionKey<AmendmentLinksContext> =
  Symbol("amendment-links");

/** Provides the links for the amendments of one document. */
export function provideAmendmentLinks(context: AmendmentLinksContext): void {
  provide(AMENDMENT_LINKS_KEY, context);
}

/** The links a page provides, or null where codes stay plain text. */
export function useAmendmentLinks(): AmendmentLinksContext | null {
  return inject(AMENDMENT_LINKS_KEY, null);
}
