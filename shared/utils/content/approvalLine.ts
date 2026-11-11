import type { AssemblyType } from "../../constants/assemblyTypes";
import type { Majority, VoteMethod } from "../../constants/domain";
import type { Block, Mark } from "../../types/content";

/**
 * The approval line of CREUP's Word templates: "Aprobada por [Mayoría] en la
 * 80.ª Asamblea General Ordinaria el [Día] de noviembre de 2026." under the
 * title, or in a regulation its history ("Modificado parcialmente en la 80ª
 * Asamblea General Ordinaria el XX de xxxxxxxxx de 202x."). Presenters leave
 * its placeholders for the Secretaría to fill in once the assembly votes.
 *
 * The import (DocxImport, templateHeader.ts) recognises it and the other
 * placeholders left in the text; the PDF of a document whose final vote
 * approved it writes the line again with the real majority, assembly and
 * date (fillApprovalLines), and leaves an unfilled one out before that.
 * The filled line is document content, so it is always in Spanish.
 */

/** How many leading blocks may hold the approval line. */
export const APPROVAL_LINE_MAX_INDEX = 4;

/** Longest approval line, in words. */
const MAX_APPROVAL_LINE_WORDS = 30;

/**
 * Template placeholders: a bracketed field ("[MAYORÍA]", "[Nº]",
 * "[Ordinaria/Extraordinaria]"; never a numeric reference such as "[1]"),
 * "DD" or "XX" for a number, a run of x for a word ("xxxxxxxxx") and a
 * year left open ("202x").
 */
const PLACEHOLDER_PATTERN =
  /\[(?!\d+\])[^\]\n]{1,40}\]|\b(?:DD|XX|XXXX)\b|\bx{3,}\b|\b\d{3}x\b/g;

/** The placeholders in a text, each once, in order. */
export function findPlaceholders(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER_PATTERN) ?? [])];
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a line is the template's approval line ("Aprobado/a…") or a
 * regulation's history line ("Modificado parcialmente…"), filled in or not.
 */
export function isApprovalLine(text: string): boolean {
  const line = normalize(text);
  return (
    /^(aprobad|modificad)[oa]s? /.test(line) &&
    line.split(" ").length <= MAX_APPROVAL_LINE_WORDS &&
    /\b(asamblea|ago|age|aget|num)\b/.test(line)
  );
}

/** An approval line still waiting for its data. */
export function isUnfilledApprovalLine(block: Block): boolean {
  return (
    !block.cell &&
    (block.type === "paragraph" || block.type === "heading") &&
    isApprovalLine(block.text) &&
    findPlaceholders(block.text).length > 0
  );
}

/** What the filled line says, from the approving final vote. */
export interface ApprovalFill {
  assembly: { number: number; type: AssemblyType };
  vote: {
    method: VoteMethod;
    majority: Majority;
    inFavor: number;
    against: number;
    abstentions: number;
    recordedAt: Date;
  };
}

const ASSEMBLY_NAMES: Record<AssemblyType, string> = {
  AGO: "Asamblea General Ordinaria",
  AGE: "Asamblea General Extraordinaria",
  AGET: "Asamblea General Extraordinaria Telemática",
};

const MAJORITY_NAMES: Record<Majority, string> = {
  simple: "mayoría simple",
  absolute: "mayoría absoluta",
  two_thirds: "mayoría de dos tercios",
};

/** "asentimiento", "unanimidad" or the majority it needed. */
function approvedBy(vote: ApprovalFill["vote"]): string {
  if (vote.method === "assent") return "asentimiento";
  if (vote.inFavor > 0 && vote.against === 0 && vote.abstentions === 0) {
    return "unanimidad";
  }
  return MAJORITY_NAMES[vote.majority];
}

/** "21 de noviembre de 2026", the day in Madrid. */
function voteDay(date: Date): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/**
 * The line written again with the vote's data, keeping its own opening
 * ("Aprobada", "Modificado parcialmente"): "Aprobada por mayoría simple en
 * la 80.ª Asamblea General Ordinaria el 21 de noviembre de 2026."
 */
export function filledApprovalText(text: string, fill: ApprovalFill): string {
  const opening =
    text
      .trim()
      .match(/^(aprobad[oa]s?|modificad[oa]s?(?:\s+parcialmente)?)/iu)?.[1] ??
    "Aprobado";
  const assembly = `${fill.assembly.number}.ª ${ASSEMBLY_NAMES[fill.assembly.type]}`;
  const by = /^aprobad/i.test(opening) ? ` por ${approvedBy(fill.vote)}` : "";
  return `${opening}${by} en la ${assembly} el ${voteDay(fill.vote.recordedAt)}.`;
}

/** The marks that covered the whole old line, stretched over the new one. */
function wholeLineMarks(block: Block, length: number): Mark[] {
  return (block.marks ?? [])
    .filter(
      (mark) => mark.from <= 0 && mark.to >= block.text.length && !mark.href,
    )
    .map((mark) => ({ ...mark, from: 0, to: length }));
}

/**
 * The text as a PDF shows it: with `fill` (the final vote approved it) the
 * unfilled approval lines among the first blocks say what was voted; without
 * it they are left out, since nothing was approved yet. Lines already filled
 * in by hand stay as they are. `filled` counts the lines written.
 */
export function fillApprovalLines(
  blocks: Block[],
  fill: ApprovalFill | null,
): { blocks: Block[]; filled: number } {
  let filled = 0;
  const out: Block[] = [];
  blocks.forEach((block, index) => {
    if (index >= APPROVAL_LINE_MAX_INDEX || !isUnfilledApprovalLine(block)) {
      out.push(block);
      return;
    }
    if (!fill) return;
    const text = filledApprovalText(block.text, fill);
    const marks = wholeLineMarks(block, text.length);
    out.push({ ...block, text, marks });
    filled++;
  });
  return { blocks: out, filled };
}
