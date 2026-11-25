import type { AmendmentOp, Block } from "~~/shared/types/content";
import { firstTouchedBlockId } from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";

/**
 * Pure helpers of «Publicadas» in the validation inbox (ValidatedList):
 * what each row says besides its code, and where the focus goes once a
 * validation is taken back.
 */

/**
 * Where an amendment first acts, as the amendment's detail says it: the
 * nearest heading before that paragraph and the paragraph's ordinal under
 * it (0 for the heading itself). Null without the text or without a block
 * it touches (a global replacement).
 */
export function passagePlace(
  ops: AmendmentOp[],
  base: Block[] | null,
): { heading: string | null; paragraph: number } | null {
  if (!base || ops.length === 0) return null;
  const id = firstTouchedBlockId(ops, base);
  if (id === null) return null;
  const label = blockLabels(base).get(id);
  if (!label || (label.heading === null && label.paragraph === 0)) return null;
  return label;
}

/** The first line of a justification with text, trimmed; null if none. */
export function justificationLead(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * The row whose «Deshacer» takes the focus once `undoneId` leaves the list
 * (ids in the order shown): the next one, else the one before it, else none
 * (the list is empty, and the caller focuses what stays). The document's
 * heading is no fallback: with its last row the whole section goes.
 */
export function focusAfterUndo(
  shownIds: readonly string[],
  undoneId: string,
): string | null {
  const index = shownIds.indexOf(undoneId);
  if (index === -1) return null;
  return shownIds[index + 1] ?? shownIds[index - 1] ?? null;
}
