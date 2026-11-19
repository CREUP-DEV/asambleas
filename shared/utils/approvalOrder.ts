/**
 * The order approved amendments apply in (consolidateApproved): the order
 * they were decided, then their number, then their id, so every screen, the
 * export and the final vote read the same text. One with no decision time
 * goes last.
 */
export interface ApprovalOrderSubject {
  id: string;
  decidedAt: string | Date | null;
  number: number | null;
}

function decidedTime(value: string | Date | null): number {
  if (value === null) return Number.POSITIVE_INFINITY;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

export function compareApproval(
  a: ApprovalOrderSubject,
  b: ApprovalOrderSubject,
): number {
  const at = decidedTime(a.decidedAt);
  const bt = decidedTime(b.decidedAt);
  if (at !== bt) return at < bt ? -1 : 1;
  const an = a.number ?? Number.MAX_SAFE_INTEGER;
  const bn = b.number ?? Number.MAX_SAFE_INTEGER;
  if (an !== bn) return an - bn;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sorted copy of `list` in approval order. */
export function inApprovalOrder<T extends ApprovalOrderSubject>(
  list: readonly T[],
): T[] {
  return [...list].sort(compareApproval);
}
