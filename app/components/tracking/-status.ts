/**
 * Pure helpers behind the documentation tracking panel: the summary counts,
 * the filters and the grouping by agenda item. Where each document stands
 * comes from `documentProgress`, as everywhere else in the app, read as the
 * Secretaría reads it. No Nuxt or Vue APIs here, so they are unit-tested on
 * their own (-status.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */
import type { AgendaItemDto, DocumentSummaryDto } from "~~/shared/types/api";
import {
  documentProgress,
  type DocumentProgressState,
} from "~/composables/document/documentProgress";
import { buildAgendaTree, flattenAgendaTree } from "~/utils/agendaTree";

export type TrackedDocument = Pick<
  DocumentSummaryDto,
  "status" | "hasContent" | "correctionNote" | "correctionRequestedAt" | "dueAt"
>;

/** The order of the summary and of the filters: the work still to do first. */
export const TRACKING_STATES: readonly DocumentProgressState[] = [
  "expected",
  "preparing",
  "correction",
  "submitted",
  "published",
  "withdrawn",
  "postponed",
];

/** Where the document stands and whether its internal deadline passed. */
export function trackingState(
  document: TrackedDocument,
  now: number,
): { state: DocumentProgressState; overdue: boolean } {
  const progress = documentProgress(document, "manager", now);
  return { state: progress.state, overdue: progress.overdue };
}

export type TrackingFilter = DocumentProgressState | "overdue" | "all";

export type TrackingSummary = Record<
  DocumentProgressState | "overdue",
  number
> & {
  total: number;
};

export function summarizeTracking(
  documents: readonly TrackedDocument[],
  now: number,
): TrackingSummary {
  const summary: TrackingSummary = {
    total: documents.length,
    overdue: 0,
    expected: 0,
    preparing: 0,
    correction: 0,
    submitted: 0,
    published: 0,
    withdrawn: 0,
    postponed: 0,
  };
  for (const document of documents) {
    const { state, overdue } = trackingState(document, now);
    summary[state] += 1;
    if (overdue) summary.overdue += 1;
  }
  return summary;
}

export function matchesTrackingFilter(
  document: TrackedDocument,
  filter: TrackingFilter,
  now: number,
): boolean {
  if (filter === "all") return true;
  const { state, overdue } = trackingState(document, now);
  return filter === "overdue" ? overdue : state === filter;
}

export interface TrackingGroup<T> {
  itemId: string;
  /** Hierarchical agenda number ("2.1"), or "" for an unknown item. */
  number: string;
  title: string;
  documents: T[];
}

type AgendaItemLike = Pick<
  AgendaItemDto,
  "id" | "parentId" | "order" | "title"
>;

/**
 * Documents under their agenda item, in agenda order. Items without
 * documents are left out; documents of an unknown item go last.
 */
export function groupByAgendaItem<T extends { agendaItemId: string }>(
  items: readonly AgendaItemLike[],
  documents: readonly T[],
): TrackingGroup<T>[] {
  const nodes = flattenAgendaTree(buildAgendaTree(items));
  const byItem = new Map<string, T[]>();
  for (const document of documents) {
    const list = byItem.get(document.agendaItemId);
    if (list) list.push(document);
    else byItem.set(document.agendaItemId, [document]);
  }
  const groups: TrackingGroup<T>[] = [];
  for (const node of nodes) {
    const list = byItem.get(node.item.id);
    if (!list) continue;
    groups.push({
      itemId: node.item.id,
      number: node.number,
      title: node.item.title,
      documents: list,
    });
    byItem.delete(node.item.id);
  }
  for (const [itemId, list] of byItem) {
    groups.push({ itemId, number: "", title: "", documents: list });
  }
  return groups;
}
