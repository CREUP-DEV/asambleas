import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import type { VoteDto } from "~~/shared/types/api";
import type { Block, ConsolidatedBlock } from "~~/shared/types/content";
import {
  fillApprovalLines,
  type ApprovalFill,
} from "~~/shared/utils/content/approvalLine";

/**
 * The template's approval line on screen (user's decision of 2026-11-26):
 * once the final vote approved the text, the views of the approved text
 * write «Aprobada por … el …» with the vote's data, as its PDF does
 * (`fillApprovalLines`), instead of «XX de xxxxxxxxx de 202x». Only what
 * is shown: the stored text keeps the line as it was written, so a
 * correction of form starts from it. Before the approval, or for the
 * original text, the line shows as written.
 */

/** What fills the line: the approving final vote, or null. */
export function screenApprovalFill(
  vote: VoteDto | null | undefined,
  assembly: { number: number; type: AssemblyType } | null | undefined,
): ApprovalFill | null {
  if (!vote || !assembly || vote.result !== "approved" || vote.voidedAt) {
    return null;
  }
  return {
    assembly: { number: assembly.number, type: assembly.type },
    vote: {
      method: vote.method,
      majority: vote.majority,
      inFavor: vote.inFavor,
      against: vote.against,
      abstentions: vote.abstentions,
      unanimous: vote.unanimous,
      recordedAt: new Date(vote.recordedAt),
    },
  };
}

/** The blocks with their approval line filled; as they are without `fill`. */
export function withFilledApprovalLine(
  blocks: Block[],
  fill: ApprovalFill | null,
): Block[] {
  return fill ? fillApprovalLines(blocks, fill).blocks : blocks;
}

/**
 * The same over a consolidation's annotated blocks: the line is read on the
 * text it keeps (deleted blocks and removed text left out), and a filled
 * one shows as plain kept text.
 */
export function withFilledApprovalLineAnnotated(
  blocks: ConsolidatedBlock[],
  fill: ApprovalFill | null,
): ConsolidatedBlock[] {
  if (!fill) return blocks;
  const shown = blocks.filter((block) => block.status !== "deleted");
  const plain: Block[] = shown.map((block) => ({
    id: block.id,
    type: block.type,
    ...(block.cell ? { cell: block.cell } : {}),
    text: block.segments
      .filter((segment) => !segment.removed)
      .map((segment) => segment.text)
      .join(""),
    marks: block.marks,
  }));
  // With a fill nothing is left out, so the blocks stay in step.
  const filled = fillApprovalLines(plain, fill).blocks;
  const changed = new Map<string, Block>();
  filled.forEach((block, index) => {
    if (block.text !== plain[index]!.text) changed.set(block.id, block);
  });
  if (changed.size === 0) return blocks;
  return blocks.map((block) => {
    const line = changed.get(block.id);
    if (!line || block.status === "deleted") return block;
    return {
      ...block,
      segments: [{ text: line.text, source: null }],
      marks: line.marks ?? [],
    };
  });
}
