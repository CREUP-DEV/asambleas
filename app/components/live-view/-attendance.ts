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
  /** Members in the room, by acronym. */
  inRoom: MemberRef[];
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
  const byAcronym = (a: MemberRef, b: MemberRef) =>
    a.acronym.localeCompare(b.acronym);
  const inRoom = latest.entries
    .filter((entry) => entry.mark === "present")
    .map((entry) => entry.member)
    .sort(byAcronym);
  const inRoomIds = new Set(inRoom.map((member) => member.id));
  const delegations = latest.entries
    .flatMap((entry) =>
      entry.mark === "delegated" && entry.delegate
        ? [
            {
              from: entry.member,
              to: entry.delegate,
              counts: inRoomIds.has(entry.delegate.id),
            },
          ]
        : [],
    )
    .sort((a, b) => byAcronym(a.from, b.from));
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
