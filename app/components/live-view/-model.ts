/**
 * Pure helpers of the attendees' live view (/asambleas/<slug>/directo) and
 * the projection: who has the floor, where every amendment of the document
 * in debate stands, and what the last recorded vote was about. No Vue or
 * Nuxt here, so it is unit-tested on its own (-model.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */
import type {
  AmendmentDto,
  LiveEventDto,
  SpeakersDto,
  SpeakingTurnDto,
  VoteDto,
} from "~~/shared/types/api";
import { sortSessionAmendments } from "~/composables/session/sessionModel";

// Speaking turns --------------------------------------------------------------

/** What attendees see of the speaking turns while the Mesa shows them. */
export interface LiveSpeakers {
  /** Who has the floor now, if anyone. */
  current: SpeakingTurnDto | null;
  /** The first ones waiting, in queue order. */
  next: SpeakingTurnDto[];
  /** Waiting turns beyond `next`. */
  more: number;
}

/** Waiting turns shown by default after the one speaking. */
export const LIVE_SPEAKERS_NEXT = 3;

function timeOf(value: string | null): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The speaking turns to show, or null when they must stay hidden: the Mesa
 * has not made them visible (either flag says so: the live state and the
 * speakers list are fetched apart and the hidden one wins), or they never
 * loaded. The Mesa receives every turn of the item (ended and cancelled
 * ones too), so only the one speaking and the waiting ones are kept.
 */
export function liveSpeakers(
  dto: SpeakersDto | null | undefined,
  visible: boolean,
  limit: number = LIVE_SPEAKERS_NEXT,
): LiveSpeakers | null {
  if (!visible || !dto?.visible) return null;
  const speaking = dto.turns
    .filter((turn) => turn.status === "speaking")
    .sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
  const waiting = dto.turns
    .filter((turn) => turn.status === "waiting")
    .sort(
      (a, b) =>
        a.position - b.position ||
        timeOf(a.createdAt) - timeOf(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const shown = Math.max(0, limit);
  return {
    current: speaking[0] ?? null,
    next: waiting.slice(0, shown),
    more: Math.max(0, waiting.length - shown),
  };
}

/**
 * Whether a batch of live events may have changed the speaking turns or
 * whether they are shown: a poll (anything may have changed), a change of
 * the live state (where `speakersVisible` lives) or a speaking-turn event
 * (entityType "speakers": `speaking_turn_*` and
 * `speakers_visibility_changed`).
 */
export function affectsSpeakers(events: readonly LiveEventDto[]): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      event.entityType === "live" ||
      event.entityType === "speakers",
  );
}

/** Entity types whose changes can alter the agenda (items and documents). */
const AGENDA_ENTITY_TYPES = new Set(["assembly", "agenda_item", "document"]);

/**
 * Whether a batch of live events may have changed the agenda: a poll or a
 * change of the assembly, an agenda item or a document. Speaking turns, the
 * live state, amendments and votes never do, so the screens every attendee
 * keeps open during the session do not refetch the agenda each time the Mesa
 * gives the floor.
 */
export function affectsAgenda(events: readonly LiveEventDto[]): boolean {
  return events.some(
    (event) =>
      event.type === "poll" || AGENDA_ENTITY_TYPES.has(event.entityType),
  );
}

// Amendments ------------------------------------------------------------------

/**
 * Where an amendment stands for the room:
 * - "debating": undecided and the one the Mesa has in debate;
 * - "pending": undecided, waiting for its turn;
 * - "late": presented after the deadline, waiting for the assembly to decide
 *   whether to treat it;
 * - the rest mirror the decided statuses.
 */
export type LiveAmendmentState =
  | "debating"
  | "pending"
  | "late"
  | "approved"
  | "rejected"
  | "transacted"
  | "withdrawn"
  | "lapsed"
  | "inadmissible";

/** Display order of the counts: what is still open first. */
export const LIVE_AMENDMENT_STATES: readonly LiveAmendmentState[] = [
  "debating",
  "pending",
  "late",
  "approved",
  "rejected",
  "transacted",
  "withdrawn",
  "lapsed",
  "inadmissible",
];

/** Badge colour of each state, in line with the amendment status badges. */
export const LIVE_STATE_COLORS: Record<
  LiveAmendmentState,
  "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral"
> = {
  debating: "primary",
  pending: "info",
  late: "warning",
  approved: "success",
  rejected: "error",
  transacted: "secondary",
  withdrawn: "neutral",
  lapsed: "warning",
  inadmissible: "error",
};

export interface LiveAmendmentRow {
  amendment: AmendmentDto;
  state: LiveAmendmentState;
  /** The amendment the Mesa has in debate (whatever its state). */
  current: boolean;
}

/** Where one amendment stands for the room. */
export function liveAmendmentState(
  amendment: AmendmentDto,
  debatedId: string | null,
): LiveAmendmentState {
  switch (amendment.status) {
    case "approved":
    case "rejected":
    case "transacted":
    case "withdrawn":
    case "lapsed":
    case "inadmissible":
      return amendment.status;
    default:
      if (amendment.admission === "pending" && amendment.late) return "late";
      return amendment.id === debatedId ? "debating" : "pending";
  }
}

/**
 * The amendments the whole room can read, in text order, with where each
 * stands. Only published ones are listed, so a member of the Mesa or the
 * Secretaría (who also receives private ones) sees what attendees see.
 */
export function liveAmendmentRows(
  list: readonly AmendmentDto[],
  debatedId: string | null,
): LiveAmendmentRow[] {
  return sortSessionAmendments(
    list.filter(
      (amendment) =>
        amendment.status !== "draft" && amendment.publishedAt !== null,
    ),
  ).map((amendment) => ({
    amendment,
    state: liveAmendmentState(amendment, debatedId),
    current: amendment.id === debatedId,
  }));
}

/** How many amendments are in each state, non-zero only, in display order. */
export function liveAmendmentCounts(
  rows: readonly LiveAmendmentRow[],
): { state: LiveAmendmentState; count: number }[] {
  const counts = new Map<LiveAmendmentState, number>();
  for (const row of rows) {
    counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  }
  return LIVE_AMENDMENT_STATES.filter((state) => counts.has(state)).map(
    (state) => ({ state, count: counts.get(state)! }),
  );
}

/** The projection's one-line summary of the amendments of a document. */
export interface LiveAmendmentStats {
  approved: number;
  /** Still to be decided: in debate, waiting for its turn, or late. */
  undecided: number;
  total: number;
}

/**
 * Totals over the rows the room can read (see liveAmendmentRows), so the
 * projection, usually opened on a Mesa or Secretaría account that also
 * receives private amendments, never reveals how many there are.
 */
export function liveAmendmentStats(
  rows: readonly LiveAmendmentRow[],
): LiveAmendmentStats {
  let approved = 0;
  let undecided = 0;
  for (const row of rows) {
    if (row.state === "approved") approved += 1;
    else if (
      row.state === "debating" ||
      row.state === "pending" ||
      row.state === "late"
    ) {
      undecided += 1;
    }
  }
  return { approved, undecided, total: rows.length };
}

/** "CEUM 4", "T1" or "#12"; empty when the amendment has neither. */
export function liveAmendmentCode(
  amendment: Pick<AmendmentDto, "code" | "number"> | null | undefined,
): string {
  if (!amendment) return "";
  return amendment.code ?? (amendment.number ? `#${amendment.number}` : "");
}

// Votes -----------------------------------------------------------------------

/** What a vote was about, for its heading. */
export type LiveVoteSubject =
  | { kind: "amendment"; code: string }
  | { kind: "amendmentUnknown" }
  | { kind: "document"; title: string }
  | { kind: "documentUnknown" }
  | { kind: "decision" }
  | { kind: "other" };

/**
 * What the vote was about: an amendment (by code, when it is among the
 * amendments the viewer can read), the final vote of the document shown, a
 * decision of the Mesa, or something else.
 */
export function liveVoteSubject(
  vote: VoteDto,
  context: {
    amendments: readonly AmendmentDto[];
    document: { id: string; title: string; reference: string | null } | null;
  },
): LiveVoteSubject {
  switch (vote.subjectType) {
    case "amendment": {
      const code = liveAmendmentCode(
        context.amendments.find((item) => item.id === vote.subjectId),
      );
      return code ? { kind: "amendment", code } : { kind: "amendmentUnknown" };
    }
    case "document":
      return context.document?.id === vote.subjectId
        ? {
            kind: "document",
            title: context.document.reference ?? context.document.title,
          }
        : { kind: "documentUnknown" };
    case "decision":
      return { kind: "decision" };
    default:
      return { kind: "other" };
  }
}

/** A translate function (vue-i18n's `t`), so this module stays pure. */
export type LiveTranslate = (
  key: string,
  params?: Record<string, unknown>,
) => string;

/** The localized heading of a vote ("Votación de la enmienda T1"). */
export function liveVoteSubjectText(
  subject: LiveVoteSubject,
  t: LiveTranslate,
): string {
  switch (subject.kind) {
    case "amendment":
      return t("projection.vote.amendment", { code: subject.code });
    case "amendmentUnknown":
      return t("projection.vote.amendmentUnknown");
    case "document":
      return t("projection.vote.document", { title: subject.title });
    case "documentUnknown":
      return t("projection.vote.document", {
        title: t("projection.vote.documentUnknown"),
      });
    case "decision":
      return t("projection.vote.decision");
    default:
      return t("projection.vote.other");
  }
}

export type LiveVoteCountKey =
  "inFavor" | "against" | "abstentions" | "blank" | "invalid";

/** The counts to show: blank and invalid only when there were any. */
export function liveVoteCounts(
  vote: VoteDto,
): { key: LiveVoteCountKey; value: number }[] {
  const counts: { key: LiveVoteCountKey; value: number }[] = [
    { key: "inFavor", value: vote.inFavor },
    { key: "against", value: vote.against },
    { key: "abstentions", value: vote.abstentions },
  ];
  if (vote.blank > 0) counts.push({ key: "blank", value: vote.blank });
  if (vote.invalid > 0) counts.push({ key: "invalid", value: vote.invalid });
  return counts;
}
