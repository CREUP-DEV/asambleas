/**
 * Which live changes the control sheet's «Historial» (History.vue) fetches
 * its first page again for: only those its filters may let in, so a vote
 * outside them never touches the list. Pure, so it is unit-tested on its
 * own (-history.test.ts). The leading dash keeps Nuxt from registering this
 * file as a component; import it explicitly.
 */

import {
  CONTROL_SHEET_ACTIVITY_GROUP_KEYS,
  CONTROL_SHEET_ACTIVITY_GROUPS,
  type ControlSheetActivityGroup,
} from "~~/shared/constants/activity";
import type { DocumentSummaryDto, LiveEventDto } from "~~/shared/types/api";

/** The «Historial»'s filters, as its query sends them. */
export interface HistoryLiveFilters {
  /** The groups chosen; none for all of them. */
  groups: readonly ControlSheetActivityGroup[];
  /**
   * "item:<id>" or "document:<id>" (an amendment chosen narrows the
   * document: still that document's); none for the whole sheet.
   */
  subject?: string;
  /** The end of the range of days (activityDateRange), if any. */
  to?: string;
}

/**
 * How far behind the reader's clock may be: a range that ended less than
 * this ago may still take what is happening now.
 */
const CLOCK_MARGIN_MS = 5 * 60 * 1000;

/**
 * Whether a batch of live events may change the «Historial» as filtered:
 * "poll" (the stream was down) always; otherwise an event of a type the
 * chosen groups list, while the range of days reaches today, about the
 * subject chosen. The stream carries ids only, so the subject is judged by
 * the event's document: one of another document (or, for an item, one of a
 * document of another item) is left out, one without a document (the
 * sheet's own notes, a vote on an item) may still be about it and counts.
 * Who did it is never in the stream: the person filter never leaves one
 * out.
 */
export function historyMayChange(
  events: readonly Pick<LiveEventDto, "type" | "documentId">[],
  filters: HistoryLiveFilters,
  documents: readonly Pick<DocumentSummaryDto, "id" | "agendaItemId">[],
  now: number,
): boolean {
  if (events.some((event) => event.type === "poll")) return true;
  if (filters.to && Date.parse(filters.to) + CLOCK_MARGIN_MS < now) {
    return false;
  }
  const groups: readonly ControlSheetActivityGroup[] = filters.groups.length
    ? filters.groups
    : CONTROL_SHEET_ACTIVITY_GROUP_KEYS;
  const types = new Set<string>(
    groups.flatMap((group) => [...CONTROL_SHEET_ACTIVITY_GROUPS[group]]),
  );
  const subject = filters.subject ?? "";
  const documentId = subject.startsWith("document:")
    ? subject.slice("document:".length)
    : null;
  const itemId = subject.startsWith("item:")
    ? subject.slice("item:".length)
    : null;
  const aboutSubject = (eventDocumentId: string | undefined): boolean => {
    if (!eventDocumentId) return true;
    if (documentId) return eventDocumentId === documentId;
    if (itemId) {
      const document = documents.find((entry) => entry.id === eventDocumentId);
      return !document || document.agendaItemId === itemId;
    }
    return true;
  };
  return events.some(
    (event) => types.has(event.type) && aboutSubject(event.documentId),
  );
}
