import type { AmendmentOp, Block } from "../../types/content";
import { passageFragment, type ApprovedConsolidation } from "./passages";

/**
 * Passages approved pending conciliation (user's decisions of 2026-11-21).
 * The final vote may approve a document while approved amendments still
 * collide in a passage the Mesa has not worded: the consolidated version is
 * stored with the automatic proposal there (the last approved wins over the
 * same text, touching changes both apply) and lists those passages as
 * pending (`document_versions.pending_passages`). Each conciliation after
 * the vote words one of them and gives a new consolidated version without
 * it; the text is final once the list is empty.
 */

/** A passage the final vote left to conciliate, as the version stores it. */
export interface PendingPassage {
  /** passageKey of the passage: what its wording is set for. */
  key: string;
  /** The approved amendments that collide there, in approval order. */
  amendmentIds: string[];
  /** The run of base blocks the passage covers. */
  blockIds: string[];
  /**
   * Its blocks in the stored text (base blocks it keeps and blocks inserted
   * after them), which every reader marks. Empty when it deletes them all.
   */
  textBlockIds: string[];
}

/** A conciliation: the wording of one pending passage, over the base. */
export interface ConciliationPassage {
  key: string;
  amendmentIds: string[];
  blockIds: string[];
  ops: AmendmentOp[];
}

/**
 * The passages of a consolidation still pending, with their blocks in its
 * text. `only` keeps those whose key it holds (a conciliation never makes a
 * passage pending that was not).
 */
export function pendingPassagesOf(
  outcome: Pick<ApprovedConsolidation, "passages" | "annotated">,
  only?: ReadonlySet<string>,
): PendingPassage[] {
  return outcome.passages
    .filter(
      (passage) =>
        passage.status === "pending" && (!only || only.has(passage.key)),
    )
    .map((passage) => ({
      key: passage.key,
      amendmentIds: [...passage.amendmentIds],
      blockIds: [...passage.blockIds],
      textBlockIds: passageFragment(outcome.annotated, passage.blockIds)
        .filter((block) => block.status !== "deleted")
        .map((block) => block.id),
    }));
}

/** The pending passages of a stored version: an empty list when final. */
export function storedPendingPassages(
  value: readonly PendingPassage[] | null | undefined,
): PendingPassage[] {
  return Array.isArray(value) ? [...value] : [];
}

/**
 * The first block of each pending passage in the text, with the amendments
 * that collide there: where readers put «Pendiente de conciliar E3 y E5».
 */
export function pendingPassageStarts(
  pending: readonly PendingPassage[],
): Map<string, string[]> {
  const starts = new Map<string, string[]>();
  for (const passage of pending) {
    const first = passage.textBlockIds[0];
    if (first && !starts.has(first)) starts.set(first, passage.amendmentIds);
  }
  return starts;
}

/**
 * The text with a bold note opening some blocks («[Pendiente de conciliar
 * E3 y E5] »), for files that render blocks as they are (the Word copy).
 * Blocks without text of their own (images, formulas) are left alone.
 */
export function withBlockNotes(
  blocks: readonly Block[],
  notes: ReadonlyMap<string, string>,
): Block[] {
  if (notes.size === 0) return [...blocks];
  return blocks.map((block) => {
    const note = notes.get(block.id);
    if (!note || block.type === "image" || block.type === "formula") {
      return block;
    }
    const prefix = `[${note}] `;
    const shift = prefix.length;
    return {
      ...block,
      text: prefix + block.text,
      marks: [
        { type: "bold" as const, from: 0, to: shift - 1 },
        ...block.marks.map((mark) => ({
          ...mark,
          from: mark.from + shift,
          to: mark.to + shift,
        })),
      ],
    };
  });
}
