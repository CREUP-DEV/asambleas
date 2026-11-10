import type { MemberKind } from "../constants/domain";

/**
 * The order members are listed in everywhere: asociados, sectorials, the
 * other members, the CEA's offices and the guests, each kind by acronym.
 * The headcount is the one exception (rollCallOrder in headcount.ts).
 */
export const MEMBER_KIND_ORDER: readonly MemberKind[] = [
  "asociado",
  "sectorial",
  "other",
  "executive",
  "guest",
];

interface Orderable {
  kind: MemberKind;
  acronym: string;
  active?: boolean;
}

function kindRank(kind: MemberKind, first: MemberKind | null): number {
  if (kind === first) return -1;
  const rank = MEMBER_KIND_ORDER.indexOf(kind);
  return rank === -1 ? MEMBER_KIND_ORDER.length : rank;
}

/**
 * Members in the general order, inactive ones last. With `first`, the
 * members of that kind lead: someone choosing who to present with looks
 * first among its own kind (an asociado among the asociados, a sectorial
 * among the sectorials, an office among the offices). Only the order
 * changes, never who is listed.
 */
export function orderMembers<T extends Orderable>(
  members: readonly T[],
  first: MemberKind | null = null,
): T[] {
  return [...members].sort(
    (a, b) =>
      Number(b.active ?? true) - Number(a.active ?? true) ||
      kindRank(a.kind, first) - kindRank(b.kind, first) ||
      a.acronym.localeCompare(b.acronym, "es", { sensitivity: "base" }),
  );
}
