import type { DocumentSummaryDto } from "~~/shared/types/api";
import {
  isDocumentPresenter,
  type PresentedDocument,
} from "./documentPresenters";

/**
 * Where a document stands, told as a short label and a sentence that says
 * what happens next. Pure: it returns i18n keys and raw values, and
 * `useDocumentProgress` turns them into text.
 *
 * - `expected`: a draft without content yet. Often created in advance by the
 *   Secretaría for the member that has to provide it, but also a draft the
 *   member has just started: nothing tells them apart, so only the variants
 *   with a deadline (set by the Secretaría) mention that it is waited for;
 * - `preparing`: a draft with content, not sent yet;
 * - `correction`: the Secretaría sent it back with a note;
 * - `submitted`: sent to the Secretaría, waiting for validation;
 * - `published`, `withdrawn`, `postponed`: as the status says.
 */
export type DocumentProgressState =
  | "expected"
  | "preparing"
  | "correction"
  | "submitted"
  | "published"
  | "withdrawn"
  | "postponed";

/**
 * Who is looking: a member presenting it (the main presenter or a
 * co-presenter, who edit the draft alike), the Secretaría (document:manage)
 * or anyone else who can see it (the Mesa, delegates).
 */
export type DocumentAudience = "presenter" | "manager" | "other";

export type DocumentProgressColor =
  "neutral" | "info" | "success" | "warning" | "error";

/** The presenter's next step on a draft. */
export type DocumentProgressAction = "prepare" | "continue" | "fix";

export interface DocumentProgress {
  state: DocumentProgressState;
  /** A draft past its internal deadline. */
  overdue: boolean;
  /** Internal deadline, only for drafts (ISO). */
  dueAt: string | null;
  /** Correction note, only while a correction is pending. */
  note: string | null;
  color: DocumentProgressColor;
  icon: string;
  /** i18n key of the short label (badges). */
  labelKey: string;
  /** i18n key of the sentence; takes `{ date }` and `{ note }`. */
  sentenceKey: string;
  /** What the presenter should do next, for a call to action. */
  action: DocumentProgressAction | null;
}

type ProgressInput = Pick<
  DocumentSummaryDto,
  "status" | "dueAt" | "hasContent" | "correctionNote" | "correctionRequestedAt"
>;

const KEY = "document.progress";

/** States where the document has not reached the Secretaría's hands yet. */
export const DRAFT_PROGRESS_STATES: readonly DocumentProgressState[] = [
  "expected",
  "preparing",
  "correction",
];

/**
 * Every badge label (`labelKey`) in the order a status filter lists them:
 * from the first step to the last.
 */
export const PROGRESS_LABEL_ORDER: readonly string[] = [
  `${KEY}.label.expected`,
  `${KEY}.label.overdue`,
  `${KEY}.label.preparing`,
  `${KEY}.label.correction`,
  `${KEY}.label.submitted`,
  "common.status.document.published",
  "common.status.document.postponed",
  "common.status.document.withdrawn",
];

/** Pre-publication states, where the next step is worth spelling out. */
export function isPendingProgress(state: DocumentProgressState): boolean {
  return DRAFT_PROGRESS_STATES.includes(state) || state === "submitted";
}

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function draftState(document: ProgressInput): DocumentProgressState {
  // Loose checks: summaries from an older server lack the new fields.
  if (document.correctionNote || document.correctionRequestedAt) {
    return "correction";
  }
  return document.hasContent === false ? "expected" : "preparing";
}

/**
 * The audience for a viewer: the Secretaría first (it validates, it does not
 * send to itself), then a presenting member (main or co-presenter), then
 * anyone else.
 */
export function documentAudience(
  document: PresentedDocument,
  viewer: { memberId: string | null | undefined; manager: boolean },
): DocumentAudience {
  if (viewer.manager) return "manager";
  if (isDocumentPresenter(document, viewer.memberId)) return "presenter";
  return "other";
}

export function documentProgress(
  document: ProgressInput,
  audience: DocumentAudience,
  now: number = Date.now(),
): DocumentProgress {
  const presenter = audience === "presenter";

  if (document.status !== "draft") {
    const base = {
      overdue: false,
      dueAt: null,
      note: null,
      action: null,
    };
    switch (document.status) {
      case "submitted":
        return {
          ...base,
          state: "submitted",
          color: "info",
          icon: "i-lucide-send",
          labelKey: `${KEY}.label.submitted`,
          sentenceKey: `${KEY}.${audience}.submitted`,
        };
      case "published":
        return {
          ...base,
          state: "published",
          color: "success",
          icon: "i-lucide-circle-check",
          labelKey: "common.status.document.published",
          sentenceKey: `${KEY}.all.published`,
        };
      case "withdrawn":
        return {
          ...base,
          state: "withdrawn",
          color: "neutral",
          icon: "i-lucide-archive",
          labelKey: "common.status.document.withdrawn",
          sentenceKey: `${KEY}.all.withdrawn`,
        };
      case "postponed":
        return {
          ...base,
          state: "postponed",
          color: "warning",
          icon: "i-lucide-calendar-clock",
          labelKey: "common.status.document.postponed",
          sentenceKey: `${KEY}.all.postponed`,
        };
    }
  }

  const state = draftState(document);
  const dueTime = toTime(document.dueAt);
  const dueAt = dueTime === null ? null : (document.dueAt ?? null);
  const overdue = dueTime !== null && dueTime <= now;
  // Presenters read "you"; the Secretaría and the Mesa read about them.
  const voice = presenter ? "presenter" : "manager";

  if (state === "correction") {
    return {
      state,
      overdue,
      dueAt,
      note: document.correctionNote ?? null,
      color: "warning",
      icon: "i-lucide-message-square-warning",
      labelKey: `${KEY}.label.correction`,
      sentenceKey: document.correctionNote
        ? `${KEY}.${voice}.correction`
        : `${KEY}.${voice}.correctionNoNote`,
      action: presenter ? "fix" : null,
    };
  }

  const timing = dueAt === null ? "" : overdue ? "Overdue" : "Due";
  if (state === "expected") {
    return {
      state,
      overdue,
      dueAt,
      note: null,
      color: overdue ? "error" : "neutral",
      icon: overdue ? "i-lucide-alarm-clock" : "i-lucide-file-clock",
      labelKey: overdue ? `${KEY}.label.overdue` : `${KEY}.label.expected`,
      sentenceKey: `${KEY}.${voice}.expected${timing}`,
      action: presenter ? "prepare" : null,
    };
  }

  return {
    state,
    overdue,
    dueAt,
    note: null,
    color: overdue ? "warning" : "neutral",
    icon: overdue ? "i-lucide-alarm-clock" : "i-lucide-file-pen-line",
    labelKey: overdue ? `${KEY}.label.overdue` : `${KEY}.label.preparing`,
    sentenceKey: `${KEY}.${voice}.preparing${timing}`,
    action: presenter ? "continue" : null,
  };
}
