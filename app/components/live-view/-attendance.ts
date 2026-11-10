import type {
  HeadcountDto,
  HeadcountsDto,
  LiveEventDto,
  MemberRef,
} from "~~/shared/types/api";
import type { AssemblySettings } from "~~/shared/constants/domain";
import { majorityThreshold } from "~~/shared/utils/votes";

/**
 * What the room sees of the Mesa's headcounts (live view and projection):
 * the latest count, the majorities it gives and who was counted. Pure, so
 * both pages and the tests share it.
 */

export interface LiveDelegation {
  from: MemberRef;
  to: MemberRef;
  /** The receiver is in the room, so the vote counts. */
  counts: boolean;
}

export interface LiveAttendance {
  latest: HeadcountDto;
  /**
   * Votes needed under each majority with majorities on the members
   * present; null when the assembly counts them on the valid votes.
   */
  majorities: { absolute: number; twoThirds: number } | null;
  /** Members with a vote in the room, in the order of the roll call. */
  inRoom: MemberRef[];
  /** Sectorials and guests in the room, who neither vote nor count. */
  attending: MemberRef[];
  delegations: LiveDelegation[];
  /** The counts before the latest, newest first. */
  earlier: HeadcountDto[];
}

/** The attendance to show, or null before the Mesa's first count. */
export function liveAttendance(
  dto: HeadcountsDto | null | undefined,
  settings: Pick<AssemblySettings, "denominator">,
): LiveAttendance | null {
  const latest = dto?.latest ?? null;
  if (!latest) return null;
  // The server sends the entries in the order of the roll call.
  const present = latest.entries.filter((entry) => entry.mark === "present");
  const inRoom = present
    .filter((entry) => entry.voting)
    .map((entry) => entry.member);
  const attending = present
    .filter((entry) => !entry.voting)
    .map((entry) => entry.member);
  const inRoomIds = new Set(inRoom.map((member) => member.id));
  const delegations = latest.entries.flatMap((entry) =>
    entry.mark === "delegated" && entry.delegate
      ? [
          {
            from: entry.member,
            to: entry.delegate,
            counts: inRoomIds.has(entry.delegate.id),
          },
        ]
      : [],
  );
  return {
    latest,
    majorities:
      settings.denominator === "present"
        ? {
            absolute: majorityThreshold("absolute", latest.present),
            twoThirds: majorityThreshold("two_thirds", latest.present),
          }
        : null,
    inRoom,
    attending,
    delegations,
    earlier: (dto?.headcounts ?? []).filter((count) => count.id !== latest.id),
  };
}

/** Live events that change the headcounts. */
export function affectsHeadcounts(events: readonly LiveEventDto[]): boolean {
  return events.some(
    (event) => event.type === "poll" || event.entityType === "headcount",
  );
}
