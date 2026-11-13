import type { AmendmentStatus, MemberKind } from "../constants/domain";
import { EXECUTIVE_AMENDMENT_CODE_PREFIX } from "../constants/domain";

/**
 * Amendment codes: the prefix of the main author followed by its number in
 * the document, with no space ("UGR1", "ANEM3", "CEA2"); transactionals are
 * "T1". Each prefix counts on its own in each document, and a number once
 * given stays taken, also when the amendment is withdrawn, deleted or
 * changes main author.
 */

/**
 * What the code of an amendment starts with, the same acronym its
 * presenter's avatar reads (accountAvatarText):
 * - a council: its university's acronym ("UGR", "UVa"), else its own;
 * - a sectorial or another member (the CAS): its acronym;
 * - every CEA office: "CEA", so a code never names the office.
 */
export function amendmentCodePrefix(member: {
  acronym: string;
  kind: MemberKind;
  universityAcronym?: string | null;
}): string {
  if (member.kind === "executive") return EXECUTIVE_AMENDMENT_CODE_PREFIX;
  if (member.kind === "asociado") {
    return member.universityAcronym?.trim() || member.acronym;
  }
  return member.acronym;
}

/** "UGR" and 3 make "UGR3". */
export function formatAmendmentCode(prefix: string, seq: number): string {
  return `${prefix}${seq}`;
}

/**
 * The number of a code in the sequence of `prefix`, or null when the code
 * is not of that sequence. Codes from before carry a space ("CEUM 2"), and
 * still count.
 */
export function amendmentCodeSeq(code: unknown, prefix: string): number | null {
  if (typeof code !== "string" || !prefix || !code.startsWith(prefix)) {
    return null;
  }
  const rest = code.slice(prefix.length).replace(/^ /, "");
  if (!/^[1-9]\d*$/.test(rest)) return null;
  return Number(rest);
}

/** An amendment of one document, as planAmendmentCodes reads it. */
export interface CodedAmendment {
  id: string;
  transactional: boolean;
  status: AmendmentStatus;
  number: number | null;
  memberSeq: number | null;
  code: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  /** The code prefix of its main author now; null when it has none. */
  prefix: string | null;
}

/** What one amendment's numbering becomes. */
export interface AmendmentCodeChange {
  id: string;
  number: number | null;
  memberSeq: number | null;
  code: string;
  previousCode: string | null;
}

/**
 * By the number they already have (codes everyone may cite keep their
 * relative order; numbered on presentation, it is the order of
 * presentation), then first presented first, then by creation.
 */
function presentationOrder(a: CodedAmendment, b: CodedAmendment): number {
  const at = (date: Date | null) => date?.getTime() ?? Number.POSITIVE_INFINITY;
  const numbered = (row: CodedAmendment) =>
    row.number ?? Number.POSITIVE_INFINITY;
  return (
    numbered(a) - numbered(b) ||
    at(a.submittedAt) - at(b.submittedAt) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The codes of a document's amendments under today's rule, for the one-off
 * recode (drizzle/recode-amendments.ts): every amendment presented (or one
 * sent back for correction that already holds a code) gets the prefix of
 * its main author now and its place among that prefix's amendments, by the
 * number they have, else in the order they were presented ("UGR1",
 * "UGR2"): "SIUEH 4" becomes "SIUEH4", never another one's. The number in the document
 * stays, and one without it takes the next. Transactionals keep their "T n"
 * and one without it takes the next. Amendments without a main author keep
 * what they have. Returns only what changes; running it again on its own
 * result returns nothing.
 */
export function planAmendmentCodes(
  rows: readonly CodedAmendment[],
): AmendmentCodeChange[] {
  const coded = rows
    .filter((row) => row.status !== "draft" || row.code !== null)
    .sort(presentationOrder);
  const changes: AmendmentCodeChange[] = [];

  let nextNumber =
    Math.max(
      0,
      ...rows.filter((row) => !row.transactional).map((row) => row.number ?? 0),
    ) + 1;
  const seqs = new Map<string, number>();
  for (const row of coded) {
    if (row.transactional || !row.prefix) continue;
    const seq = (seqs.get(row.prefix) ?? 0) + 1;
    seqs.set(row.prefix, seq);
    const number = row.number ?? nextNumber++;
    const code = formatAmendmentCode(row.prefix, seq);
    if (code !== row.code || seq !== row.memberSeq || number !== row.number) {
      changes.push({
        id: row.id,
        number,
        memberSeq: seq,
        code,
        previousCode: row.code,
      });
    }
  }

  let lastT = Math.max(
    0,
    ...rows
      .filter((row) => row.transactional)
      .map((row) => amendmentCodeSeq(row.code, "T") ?? 0),
  );
  for (const row of coded) {
    if (!row.transactional) continue;
    const held = amendmentCodeSeq(row.code, "T");
    const code = formatAmendmentCode("T", held ?? ++lastT);
    if (code !== row.code) {
      changes.push({
        id: row.id,
        number: row.number,
        memberSeq: row.memberSeq,
        code,
        previousCode: row.code,
      });
    }
  }
  return changes;
}
