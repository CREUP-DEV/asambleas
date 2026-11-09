/**
 * Headcounts the Mesa takes during the session (docs/design.md,
 * "Headcounts and quorum"): who is in the room among the members with a
 * vote (the active asociados), and who votes through another member's
 * delegation. Pure functions shared by the server, which stores the count,
 * and the Mesa's form, which previews it.
 */

/**
 * The share of the members with a vote that makes quorum: at least
 * `numerator / denominator` of them, or more than that when `strict`.
 */
export interface QuorumThreshold {
  numerator: number;
  denominator: number;
  strict: boolean;
}

/**
 * The quorum of an assembly type, stored with its calendar rules
 * (`calendar_rules`, edited at /admin/calendario). `secondCall` is null for
 * a type convened in a single call.
 */
export interface QuorumRules {
  firstCall: QuorumThreshold;
  secondCall: QuorumThreshold | null;
}

export const QUORUM_CALLS = ["first", "second"] as const;
export type QuorumCall = (typeof QUORUM_CALLS)[number];

/** Members needed for quorum out of `eligible` members with a vote. */
export function quorumRequired(
  eligible: number,
  threshold: QuorumThreshold,
): number {
  const share = eligible * threshold.numerator;
  if (threshold.strict) return Math.floor(share / threshold.denominator) + 1;
  return Math.ceil(share / threshold.denominator);
}

/** The threshold of a call; a type with a single call always uses the first. */
export function quorumThreshold(
  rules: QuorumRules,
  call: QuorumCall,
): QuorumThreshold {
  return call === "second" && rules.secondCall
    ? rules.secondCall
    : rules.firstCall;
}

/** How an asociado takes part in a headcount; absent ones are not listed. */
export const ATTENDANCE_MARKS = ["present", "delegated"] as const;
export type AttendanceMark = (typeof ATTENDANCE_MARKS)[number];

export interface AttendanceEntry {
  memberId: string;
  mark: AttendanceMark;
  /** The member present that votes for this one (only when `delegated`). */
  delegateId?: string | null;
}

export const HEADCOUNT_PROBLEMS = [
  /** A member is listed twice. */
  "duplicate",
  /** A member is not an active asociado. */
  "not_eligible",
  /** A delegation names no member with a vote, or the member itself. */
  "delegate_missing",
  /** A member receives more than one delegation. */
  "delegate_twice",
] as const;
export type HeadcountProblem = (typeof HEADCOUNT_PROBLEMS)[number];

export interface HeadcountTally {
  /** Members in the room. */
  inRoom: number;
  /** Delegated votes that count: their receiver is in the room. */
  delegated: number;
  /** Members present for quorum and majorities: in the room plus delegated. */
  present: number;
  /**
   * Members whose delegation is kept but does not count, because whoever
   * receives it is not in the room.
   */
  uncounted: Set<string>;
  /** What keeps the count from being stored, by member id. */
  problems: Map<string, HeadcountProblem>;
}

/**
 * Counts a headcount and finds what is wrong with it. A delegated vote
 * counts for quorum and for every vote (RRI art. 19.3, RFAG art. 9.4) only
 * while the member that receives it is in the room; otherwise the
 * delegation is kept (it counts again once that member is back) but adds
 * nothing. Each member receives at most one delegation (Estatutos art.
 * 17.1, RFAG art. 8.5). `eligible` holds the ids of the members with a vote
 * (active asociados).
 */
export function tallyHeadcount(
  entries: readonly AttendanceEntry[],
  eligible: ReadonlySet<string>,
): HeadcountTally {
  const problems = new Map<string, HeadcountProblem>();
  const seen = new Set<string>();
  const inRoom = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.memberId)) {
      problems.set(entry.memberId, "duplicate");
      continue;
    }
    seen.add(entry.memberId);
    if (!eligible.has(entry.memberId)) {
      problems.set(entry.memberId, "not_eligible");
      continue;
    }
    if (entry.mark === "present") inRoom.add(entry.memberId);
  }

  const received = new Set<string>();
  const uncounted = new Set<string>();
  let delegated = 0;
  for (const entry of entries) {
    if (entry.mark !== "delegated" || problems.has(entry.memberId)) continue;
    const delegateId = entry.delegateId ?? null;
    if (
      !delegateId ||
      delegateId === entry.memberId ||
      !eligible.has(delegateId)
    ) {
      problems.set(entry.memberId, "delegate_missing");
      continue;
    }
    if (received.has(delegateId)) {
      problems.set(entry.memberId, "delegate_twice");
      continue;
    }
    received.add(delegateId);
    if (inRoom.has(delegateId)) delegated += 1;
    else uncounted.add(entry.memberId);
  }

  return {
    inRoom: inRoom.size,
    delegated,
    present: inRoom.size + delegated,
    uncounted,
    problems,
  };
}
