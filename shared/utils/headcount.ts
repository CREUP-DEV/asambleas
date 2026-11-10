import type { MemberKind } from "../constants/domain";

/**
 * Headcounts the Mesa takes during the session (docs/design.md,
 * "Headcounts and quorum"): who is in the room among the members with a
 * vote (the active asociados), who votes through another member's
 * delegation, and which sectorials and guests attend, who never vote nor
 * count for quorum. Pure functions shared by the server, which stores the
 * count, and the Mesa's form, which previews it.
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

/**
 * The call every headcount is taken under. An assembly always starts in
 * second call, so a type with two calls counts on the second one's quorum;
 * a type convened in a single call, on that one.
 */
export function sessionCall(rules: QuorumRules): QuorumCall {
  return rules.secondCall ? "second" : "first";
}

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

/**
 * Who a headcount lists, in the order the roll is called: the asociados,
 * who vote, then the sectorials and the guests, who only attend.
 */
export const ROLL_CALL_KINDS = [
  "asociado",
  "sectorial",
  "guest",
] as const satisfies readonly MemberKind[];

/** The members with a vote: the asociados. */
export function votesInHeadcount(kind: MemberKind): boolean {
  return kind === "asociado";
}

interface RollCallMember {
  kind: MemberKind;
  acronym: string;
  name: string;
  university?: string | null;
}

/**
 * How a member is called: its denomination ("Consejo de Estudiantes"), with
 * the university after it when it has one.
 */
function rollCallName(member: RollCallMember): string {
  return member.university
    ? `${member.name} ${member.university}`
    : member.name;
}

function rollCallRank(kind: MemberKind): number {
  const rank = (ROLL_CALL_KINDS as readonly MemberKind[]).indexOf(kind);
  return rank === -1 ? ROLL_CALL_KINDS.length : rank;
}

/**
 * The order of the roll call, the one exception to orderMembers: asociados,
 * sectorials and guests, each in reverse alphabetical order of its
 * denomination and university, as the Secretaría calls them.
 */
export function compareRollCall(a: RollCallMember, b: RollCallMember): number {
  return (
    rollCallRank(a.kind) - rollCallRank(b.kind) ||
    rollCallName(b).localeCompare(rollCallName(a), "es", {
      sensitivity: "base",
    }) ||
    a.acronym.localeCompare(b.acronym, "es", { sensitivity: "base" })
  );
}

/** Members in the order of the roll call (compareRollCall). */
export function rollCallOrder<T extends RollCallMember>(
  members: readonly T[],
): T[] {
  return [...members].sort(compareRollCall);
}

/**
 * How a member takes part in a headcount; absent ones are not listed. Only
 * an asociado delegates.
 */
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
  /** A member is no longer an active asociado, sectorial nor guest. */
  "not_eligible",
  /** A sectorial or a guest delegates, though it has no vote. */
  "no_vote",
  /** A delegation names no member with a vote, or the member itself. */
  "delegate_missing",
  /** A member receives more than one delegation. */
  "delegate_twice",
] as const;
export type HeadcountProblem = (typeof HEADCOUNT_PROBLEMS)[number];

export interface HeadcountTally {
  /** Members with a vote in the room. */
  inRoom: number;
  /** Sectorials and guests in the room: they never count. */
  attending: number;
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
 * (active asociados); `attendees`, those of the sectorials and guests that
 * may be marked in the room, who add nothing to quorum nor to `present`,
 * never delegate and never receive a delegation.
 */
export function tallyHeadcount(
  entries: readonly AttendanceEntry[],
  eligible: ReadonlySet<string>,
  attendees: ReadonlySet<string> = new Set(),
): HeadcountTally {
  const problems = new Map<string, HeadcountProblem>();
  const seen = new Set<string>();
  const inRoom = new Set<string>();
  let attending = 0;
  for (const entry of entries) {
    if (seen.has(entry.memberId)) {
      problems.set(entry.memberId, "duplicate");
      continue;
    }
    seen.add(entry.memberId);
    if (!eligible.has(entry.memberId)) {
      if (!attendees.has(entry.memberId)) {
        problems.set(entry.memberId, "not_eligible");
      } else if (entry.mark !== "present") {
        problems.set(entry.memberId, "no_vote");
      } else {
        attending += 1;
      }
      continue;
    }
    if (entry.mark === "present") inRoom.add(entry.memberId);
  }

  const received = new Set<string>();
  const uncounted = new Set<string>();
  let delegated = 0;
  for (const entry of entries) {
    if (entry.mark !== "delegated" || problems.has(entry.memberId)) continue;
    if (!eligible.has(entry.memberId)) continue;
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
    attending,
    delegated,
    present: inRoom.size + delegated,
    uncounted,
    problems,
  };
}
