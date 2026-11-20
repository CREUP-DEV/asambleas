/**
 * Which live events make the room refetch the AssemblyDto, the agenda, the
 * read marks and a DocumentDto. Pure, so it is unit-tested on its own
 * (-liveFilters.test.ts).
 *
 * Each filter lists what may change its DTO, read off the server's loader
 * and the events recorded next to its writes: a filter that misses one
 * leaves a stale screen until the next poll, and one that lets everything
 * through makes the whole room refetch on every vote.
 *
 * The leading dash keeps Nuxt from auto-importing this file
 * (`ignorePrefix`); import it explicitly.
 */
import type { LiveEventDto } from "~~/shared/types/api";

type LiveEventLike = Pick<LiveEventDto, "type" | "entityType">;
type ScopedLiveEvent = Pick<
  LiveEventDto,
  "type" | "entityType" | "entityId" | "documentId"
>;

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
 * left to read follow them. Admitting a late amendment publishes it, and
 * declaring a returned draft inadmissible makes it count as presented: both
 * come with a `decision` event, which no longer refetches the agenda, so
 * they are listed here. A withdrawn one put back in debate
 * (`amendment_reopened`) is seen again, so it counts too (user's decision of
 * 2026-11-20, reversing the morning's); reopenings are rare. Deciding one
 * (approved, rejected, lapsed, transacted), its presenter's answer, an
 * acceptance or a wording changes none of that, and every client
 * refetching the whole agenda for each of them is what slowed the session
 * down.
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
  "amendment_admitted",
  "amendment_inadmissible",
  "amendment_reopened",
]);

/**
 * The amendment events that may change a DocumentDto's `amendmentCount`
 * or `hasAmendments` (countVisibleAmendments, hasAnyAmendment): the listing
 * types and a change of who counts as one of its insiders, who see it
 * before it is public: its authors (`amendment_authors_changed`) and the
 * parties of a transactional (`transactional_source_dropped` takes some
 * away, `transactional_revision_applied` adds them).
 */
export const DOCUMENT_AMENDMENT_COUNT_TYPES: ReadonlySet<string> = new Set([
  ...AMENDMENT_LISTING_TYPES,
  "amendment_authors_changed",
  "transactional_source_dropped",
  "transactional_revision_applied",
]);

/**
 * What is left to read follows the same events as the agenda, plus a change
 * of an amendment's text or of who presents it (one's own never counts as
 * left to read).
 */
export const READ_MARK_AMENDMENT_TYPES: ReadonlySet<string> = new Set([
  ...AMENDMENT_LISTING_TYPES,
  "amendment_updated",
  "amendment_authors_changed",
]);

/**
 * Document events of the session itself: the main presenter's answers
 * opened to debate or published, and the Mesa's wording of a passage.
 * Neither the AssemblyDto nor the read marks read them (loadAssemblyDto,
 * loadMarkable), and `document_positions_debate_started` comes the first
 * time each document goes into debate, so they would make every device
 * fetch both again for nothing. An exclusion list: a new document event
 * keeps refetching until someone checks it. The agenda and the DocumentDto
 * still follow the answers (`positionsPublishedAt`,
 * `positionsDebateStartedAt`, `positionsVisible`).
 */
export const SESSION_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "document_positions_debate_started",
  "document_positions_published",
  "document_positions_unpublished",
  "passage_worded",
  "passage_wording_removed",
]);

/**
 * The Mesa's wording of a passage: the amendments list shows it, the
 * DocumentDto does not (it never touches the document's row).
 */
const PASSAGE_WORDING_TYPES: ReadonlySet<string> = new Set([
  "passage_worded",
  "passage_wording_removed",
]);

/** A document event that may change the AssemblyDto or the read marks. */
function isDocumentChange(event: LiveEventLike): boolean {
  return (
    event.entityType === "document" && !SESSION_DOCUMENT_TYPES.has(event.type)
  );
}

/** Whether a batch of live events may change what is left to read. */
export function shouldRefetchReadMarks(
  events: readonly LiveEventLike[],
): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      isDocumentChange(event) ||
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
    isDocumentChange(event)
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
 * Entities whose events may change the agenda: the assembly (the calendar
 * that sets each document's window, the order of the items), its items and
 * its documents (each one's summary).
 */
const AGENDA_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "assembly",
  "agenda_item",
  "document",
]);

/**
 * Whether a batch of live events calls for refetching the agenda (items and
 * document summaries): a poll, the assembly, an agenda item or a document,
 * and of the amendments only what changes which ones are seen
 * (AMENDMENT_LISTING_TYPES). An allow-list: votes, decisions, headcounts and
 * the projection's control change nothing in it («Se vota el punto» is the
 * item's own flag, not its vote), and they come with every vote.
 */
export function shouldRefetchAgenda(events: readonly LiveEventLike[]): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      (mayChangeAssemblyData(event) &&
        (AGENDA_ENTITY_TYPES.has(event.entityType) ||
          (event.entityType === "amendment" &&
            AMENDMENT_LISTING_TYPES.has(event.type)))),
  );
}

/**
 * Whether a batch of live events may change the DocumentDto of this
 * document (loadDocumentDto), so the room refetches it only then, not on
 * every vote, answer or acceptance of one of its amendments:
 * - a poll (anything may have changed);
 * - an event of the document itself, but for the Mesa's wording of a
 *   passage (its row, versions, presenters, final vote, answers);
 * - one of its amendments appearing, going or changing who sees it
 *   (DOCUMENT_AMENDMENT_COUNT_TYPES: `amendmentCount`, `hasAmendments`);
 * - its final vote (`finalVoteId`): its unanimity changes as a `vote`
 *   event;
 * - the assembly (its status and calendar set the window and `can`).
 * The live state never changes it: putting the document on screen stamps
 * it projected without moving its `updatedAt` (stampProjected), so a form
 * open on it never turns stale on a `live_changed`, which carries no
 * `documentId`. Its amendments list follows every event of the document
 * instead (isDocumentLiveBatch).
 */
export function affectsDocumentDto(
  events: readonly ScopedLiveEvent[],
  documentId: string | null | undefined,
  finalVoteId?: string | null,
): boolean {
  return events.some((event) => {
    if (event.type === "poll") return true;
    if (!documentId) return false;
    switch (event.entityType) {
      case "document":
        return (
          event.entityId === documentId &&
          !PASSAGE_WORDING_TYPES.has(event.type)
        );
      case "amendment":
        return (
          event.documentId === documentId &&
          DOCUMENT_AMENDMENT_COUNT_TYPES.has(event.type)
        );
      case "vote":
        return Boolean(finalVoteId) && event.entityId === finalVoteId;
      case "assembly":
        return true;
      default:
        return false;
    }
  });
}
