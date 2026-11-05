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
 * state (what the room is debating) and the speaking turns, which the Mesa
 * changes all session long. Section pages that show them still receive
 * every event through onLive.
 */
const IGNORED_LIVE_TYPES: ReadonlySet<string> = new Set(["live_changed"]);
const IGNORED_LIVE_ENTITIES: ReadonlySet<string> = new Set(["speakers"]);

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

/** Whether a batch of live events calls for refetching the agenda. */
export function shouldRefetchAgenda(events: readonly LiveEventLike[]): boolean {
  return events.some(mayChangeAssemblyData);
}
