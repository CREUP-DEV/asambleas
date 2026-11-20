/**
 * Which live events make the assembly hub refetch the AssemblyDto and the
 * agenda. Pure, so it is unit-tested on its own (-liveFilters.test.ts).
 *
 * The leading dash keeps Nuxt from auto-importing this file
 * (`ignorePrefix`); import it explicitly.
 */
import type { LiveEventDto } from "~~/shared/types/api";

type LiveEventLike = Pick<LiveEventDto, "type" | "entityType">;

/**
 * Live events that change neither the AssemblyDto nor the agenda: the live
 * state (what the room is debating), the speaking turns, which the Mesa
 * changes all session long, the control sheet, whose notes reach no one
 * else, and the room (Sala), where every seat moved is an event. Section
 * pages that show them still receive every event through onLive.
 */
const IGNORED_LIVE_TYPES: ReadonlySet<string> = new Set(["live_changed"]);
const IGNORED_LIVE_ENTITIES: ReadonlySet<string> = new Set([
  "speakers",
  "control_sheet",
  "seating",
]);

/**
 * The amendment events that change which amendments a reader sees, or
 * whether a document has any (user's decision of 2026-11-20): the agenda's
 * counts (DocumentSummaryDto.amendmentCount, `hasAmendments`) and what is
 * left to read follow them. Deciding one (approved, rejected, lapsed,
 * transacted, reopened), its presenter's answer, an acceptance or a wording
 * changes none of that, and every client refetching the whole agenda for
 * each of them is what slowed the session down.
 */
export const AMENDMENT_LISTING_TYPES: ReadonlySet<string> = new Set([
  "amendment_created",
  "amendment_deleted",
  "amendment_submitted",
  "amendment_published",
  "amendment_validated",
  "amendment_validation_undone",
  "amendment_correction_requested",
  "amendment_withdrawn",
]);

/**
 * What is left to read follows the same events, plus a change of an
 * amendment's text or of who presents it (one's own never counts as left to
 * read).
 */
export const READ_MARK_AMENDMENT_TYPES: ReadonlySet<string> = new Set([
  ...AMENDMENT_LISTING_TYPES,
  "amendment_updated",
  "amendment_authors_changed",
]);

/** Whether a batch of live events may change what is left to read. */
export function shouldRefetchReadMarks(
  events: readonly LiveEventLike[],
): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      event.entityType === "document" ||
      (event.entityType === "amendment" &&
        READ_MARK_AMENDMENT_TYPES.has(event.type)),
  );
}

/** Whether an event may change the assembly or its agenda. */
export function mayChangeAssemblyData(event: LiveEventLike): boolean {
  return (
    !IGNORED_LIVE_TYPES.has(event.type) &&
    !IGNORED_LIVE_ENTITIES.has(event.entityType)
  );
}

/** Live events that may change the AssemblyDto itself. */
function touchesAssembly(event: LiveEventLike): boolean {
  return (
    event.type === "poll" ||
    event.entityType === "assembly" ||
    // documentCount and nextMilestone depend on documents.
    event.entityType === "document"
  );
}

/** Whether a batch of live events calls for refetching the AssemblyDto. */
export function shouldRefetchAssembly(
  events: readonly LiveEventLike[],
): boolean {
  return events.some(
    (event) => mayChangeAssemblyData(event) && touchesAssembly(event),
  );
}

/**
 * Whether a batch of live events calls for refetching the agenda: anything
 * that may change it, but of the amendments only what changes which ones
 * are seen (AMENDMENT_LISTING_TYPES).
 */
export function shouldRefetchAgenda(events: readonly LiveEventLike[]): boolean {
  return events.some(
    (event) =>
      mayChangeAssemblyData(event) &&
      (event.entityType !== "amendment" ||
        AMENDMENT_LISTING_TYPES.has(event.type)),
  );
}
