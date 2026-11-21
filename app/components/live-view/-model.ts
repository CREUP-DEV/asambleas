import { shownVoteCounts } from "~~/shared/utils/votes";
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
  LiveTally,
  LiveTallyCounts,
  MemberRef,
  SpeakersDto,
  SpeakingTurnDto,
  VoteDto,
} from "~~/shared/types/api";
import type { VoteSubject } from "~~/shared/constants/domain";
import type { AmendmentOrderOptions } from "~~/shared/utils/amendmentOrder";
import {
  isSessionReplacing,
  sessionSupersededSourceIds,
  sessionTransactionalRejectors,
  sortSessionAmendments,
} from "~/composables/session/sessionModel";
import { numberedAgendaTitle } from "~/utils/agendaTree";
import { memberSpokenName, positionRecorderKey } from "~/utils/format";

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
 * whether they are shown: a poll (anything may have changed) or a
 * speaking-turn event (entityType "speakers": `speaking_turn_*` and
 * `speakers_visibility_changed`). Not a change of the live state
 * (`live_changed`), the Mesa's most frequent event: every change of
 * `speakersVisible` also records `speakers_visibility_changed`, and the
 * room only shows the turns speaking and waiting, whatever is in debate.
 */
export function affectsSpeakers(events: readonly LiveEventDto[]): boolean {
  return events.some(
    (event) => event.type === "poll" || event.entityType === "speakers",
  );
}

/**
 * The speaking-turn events that may change the turns that spoke (speaking,
 * done or noted by hand), as GET .../speakers/notes lists them: a turn
 * takes the floor, ends, is cancelled or put back, is edited, or is noted
 * by hand or unnoted. Not a turn added to the queue or moved in it (it is
 * waiting), nor the queue shown or hidden.
 */
export const SPOKEN_TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "speaking_turn_started",
  "speaking_turn_finished",
  "speaking_turn_cancelled",
  "speaking_turn_restored",
  "speaking_turn_updated",
  "speaking_turn_noted",
  "speaking_turn_unnoted",
]);

/**
 * Whether a batch of live events may have changed the turns that spoke
 * (whoever notes the speakers in the live view): a poll, or a
 * SPOKEN_TURN_EVENT_TYPES event.
 */
export function affectsSpokenTurns(events: readonly LiveEventDto[]): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      (event.entityType === "speakers" &&
        SPOKEN_TURN_EVENT_TYPES.has(event.type)),
  );
}

// Where the Mesa has the document scrolled ---------------------------------------

/**
 * Whether a position of the Mesa read from GET .../live-scroll may replace
 * the one the page has: a read that left before a newer position arrived
 * on the stream must not put the view back where the Mesa was. Every
 * position is stamped by the one server process that keeps them (`at`), so
 * the newer one wins, whatever its document.
 */
export function isNewerScroll(
  current: { at: string } | null | undefined,
  next: { at: string },
): boolean {
  if (!current) return true;
  const was = Date.parse(current.at);
  const is = Date.parse(next.at);
  if (Number.isNaN(was) || Number.isNaN(is)) return true;
  return is > was;
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
 * - "incorporated": in the text without a vote, because the document's main
 *   presenter accepted it (documents that incorporate accepted amendments);
 * - "transacted": replaced by a transactional, debated in its place;
 * - "turned_down": a transactional some main author did not accept: it is
 *   closed and the amendments it would have replaced carry on (the server
 *   records it as withdrawn, but nobody who presented it withdrew it);
 * - the rest mirror the decided statuses.
 */
export type LiveAmendmentState =
  | "debating"
  | "pending"
  | "late"
  | "approved"
  | "incorporated"
  | "rejected"
  | "transacted"
  | "turned_down"
  | "withdrawn"
  | "lapsed"
  | "inadmissible";

/** Display order of the counts: what is still open first. */
export const LIVE_AMENDMENT_STATES: readonly LiveAmendmentState[] = [
  "debating",
  "pending",
  "late",
  "approved",
  "incorporated",
  "rejected",
  "transacted",
  "turned_down",
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
  incorporated: "success",
  rejected: "error",
  transacted: "secondary",
  turned_down: "neutral",
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
  if (
    amendment.status !== "approved" &&
    sessionTransactionalRejectors(amendment).length > 0
  ) {
    return "turned_down";
  }
  switch (amendment.status) {
    case "approved":
      return amendment.approvalMethod === "proponent"
        ? "incorporated"
        : "approved";
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
 * The amendments the whole room can read, in the console's order (text
 * order, grouped by the main presenter's answer once the document's answers
 * are public: `byAnswer`, sortSessionAmendments), with where each
 * stands. Only published ones are listed, so a member of the Mesa or the
 * Secretaría (who also receives private ones) sees what attendees see.
 */
export function liveAmendmentRows(
  list: readonly AmendmentDto[],
  debatedId: string | null,
  options: AmendmentOrderOptions = {},
): LiveAmendmentRow[] {
  return sortSessionAmendments(
    list.filter(
      (amendment) =>
        amendment.status !== "draft" && amendment.publishedAt !== null,
    ),
    options,
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
  /** In the text: approved, by vote or incorporated without one. */
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
    if (row.state === "approved" || row.state === "incorporated") {
      approved += 1;
    } else if (
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

/**
 * The codes of the amendments a transactional combines, in text order (as
 * the bloc chips: its sources are stored in no order of their own), among
 * those the room can read (published ones): the projection says
 * «Transacciona las enmiendas E3 y E5» under its title. Empty for any
 * other amendment, or when none of them is listed.
 */
export function liveTransactedCodes(
  amendment: Pick<AmendmentDto, "kind" | "sourceIds">,
  list: readonly AmendmentDto[],
): string[] {
  if (amendment.kind !== "transactional") return [];
  const wanted = new Set(amendment.sourceIds);
  const codes: string[] = [];
  for (const source of sortSessionAmendments(
    list.filter(
      (item) =>
        wanted.has(item.id) &&
        item.status !== "draft" &&
        item.publishedAt !== null,
    ),
  )) {
    const code = liveAmendmentCode(source);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** One amendment of the bloc on screen, as the room reads it. */
export interface LiveBlocEntry {
  id: string;
  code: string;
  /** Its main author (the first one), named by acronym on the chip. */
  author: MemberRef | null;
  /** Approved already: its chip turns green as the Mesa approves it. */
  approved: boolean;
  /** Decided some other way (rejected, withdrawn, lapsed...). */
  settled: boolean;
  /**
   * A transactional's sources the room reads, in text order (user's
   * decision of 2026-11-20): its chip says which ones it transacts.
   */
  transacts: string[];
}

/**
 * The bloc on screen («Se propone aprobar en bloque», user's decision of
 * 2026-11-19) in text order, among the amendments the room can read
 * (published ones): the projection's chips and the live view's notice.
 */
export function liveBlocEntries(
  ids: readonly string[] | null | undefined,
  list: readonly AmendmentDto[],
): LiveBlocEntry[] {
  if (!ids || ids.length === 0) return [];
  const wanted = new Set(ids);
  return sortSessionAmendments(
    list.filter(
      (item) =>
        wanted.has(item.id) &&
        item.status !== "draft" &&
        item.publishedAt !== null,
    ),
  ).map((item) => ({
    id: item.id,
    code: liveAmendmentCode(item),
    author: item.authors[0] ?? null,
    approved: item.status === "approved",
    settled: item.status !== "approved" && item.status !== "submitted",
    transacts: liveTransactedCodes(item, list),
  }));
}

/** A sentence under a row, as an i18n key and its parameters. */
export interface LiveAmendmentNote {
  key: string;
  params?: Record<string, string>;
}

function codesOf(
  ids: readonly string[],
  rows: readonly LiveAmendmentRow[],
): string {
  return ids
    .map((id) =>
      liveAmendmentCode(rows.find((row) => row.amendment.id === id)?.amendment),
    )
    .filter(Boolean)
    .join(", ");
}

/**
 * The transactional that replaced an amendment, among the rows the room can
 * read: one built on it that no main author turned down, the one that
 * actually replaced it first (isSessionReplacing), then an approved one,
 * then one still being debated. Null when none is listed.
 */
export function liveReplacedBy(
  row: LiveAmendmentRow,
  rows: readonly LiveAmendmentRow[],
): LiveAmendmentRow | null {
  const ids = new Set(row.amendment.transactionalIds);
  const candidates = rows.filter(
    (other) =>
      ids.has(other.amendment.id) &&
      other.state !== "turned_down" &&
      sessionTransactionalRejectors(other.amendment).length === 0,
  );
  const rank = (other: LiveAmendmentRow) =>
    isSessionReplacing(other.amendment)
      ? 0
      : other.state === "approved" || other.state === "incorporated"
        ? 1
        : other.state === "debating" || other.state === "pending"
          ? 2
          : 3;
  return [...candidates].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/**
 * A sentence for the rows a badge alone does not explain: a late amendment
 * waiting for the assembly, one replaced by a transactional (naming it), one
 * incorporated without a vote and, for a transactional, whether a main
 * author turned it down, which amendments it already replaced, whether
 * another transactional got ahead of it, or whether it still waits for its
 * main authors. Null otherwise.
 */
/**
 * The other amendments a row's note may name (what it combines and the
 * transactionals over it), so their codes preview and open them
 * (AmendmentLinkedText, user's decision of 2026-11-20).
 */
export function liveNoteMentions(
  amendment: Pick<AmendmentDto, "sourceIds" | "transactionalIds">,
): string[] {
  return [...amendment.sourceIds, ...amendment.transactionalIds];
}

export function liveAmendmentNote(
  row: LiveAmendmentRow,
  rows: readonly LiveAmendmentRow[],
): LiveAmendmentNote | null {
  const amendment = row.amendment;
  if (row.state === "late") return { key: "liveView.state.late.sentence" };
  if (row.state === "transacted") {
    const code = liveAmendmentCode(liveReplacedBy(row, rows)?.amendment);
    return code
      ? { key: "liveView.state.transacted.by", params: { code } }
      : { key: "liveView.state.transacted.sentence" };
  }
  if (row.state === "incorporated") {
    return { key: "liveView.state.incorporated.sentence" };
  }
  if (amendment.kind !== "transactional") return null;
  const rejectors = sessionTransactionalRejectors(amendment);
  if (rejectors.length > 0) {
    return {
      key: "liveView.amendments.turnedDown",
      params: { members: rejectors.map((member) => member.acronym).join(", ") },
    };
  }
  const replaced = isSessionReplacing(amendment)
    ? rows
        .filter(
          (other) =>
            amendment.sourceIds.includes(other.amendment.id) &&
            other.state === "transacted",
        )
        .map((other) => other.amendment.id)
    : [];
  if (replaced.length > 0) {
    return {
      key: "liveView.amendments.replaces",
      params: { codes: codesOf(replaced, rows) },
    };
  }
  // Another transactional replaced (or a decision settled) one of its
  // sources first: it will not go ahead.
  const byId = new Map(
    rows.map((other) => [other.amendment.id, other.amendment]),
  );
  const gone = sessionSupersededSourceIds(amendment, byId);
  if (gone.length > 0) {
    return {
      key: "liveView.amendments.superseded",
      params: { codes: codesOf(gone, rows) },
    };
  }
  const waiting =
    amendment.status === "submitted" &&
    amendment.acceptances.some((party) => party.decision !== "accepted");
  const sources = codesOf(amendment.sourceIds, rows);
  if (waiting && sources) {
    return {
      key: "liveView.amendments.awaitingAuthors",
      params: { codes: sources },
    };
  }
  return null;
}

/**
 * How the document's main presenter answered the amendment, as one sentence
 * naming it by its acronym ("Respuesta de CEUM: la acepta"), saying the
 * Mesa recorded it on its behalf ("La Mesa, en nombre de CEUM, la aceptó"),
 * or that a formal amendment was accepted by itself.
 * Null while nobody has answered, when the viewer does not receive the
 * answer (the server sends no position) or the document has no main
 * presenter. Whether the room may see it is the caller's rule.
 */
export function livePositionLine(
  amendment: Pick<AmendmentDto, "position">,
  presenter: Pick<MemberRef, "acronym" | "name"> | null | undefined,
): LiveAmendmentNote | null {
  const position = amendment.position;
  if (!position || !presenter || position.position === "pending") return null;
  // A formal amendment accepted by itself: nobody answered it.
  if (position.recordedBy === "auto" && position.position === "accept") {
    return { key: "amendment.position.answerAuto", params: {} };
  }
  const group =
    position.recordedBy === "mesa"
      ? `amendment.position.answersBy${positionRecorderKey(position)}`
      : "amendment.position.answers";
  return {
    key: `${group}.${position.position}`,
    params: { member: memberSpokenName(presenter) },
  };
}

// Votes -----------------------------------------------------------------------

/** What a vote was about, for its heading. */
export type LiveVoteSubject =
  | { kind: "amendment"; code: string }
  | { kind: "amendmentUnknown" }
  | { kind: "document"; title: string }
  | { kind: "documentUnknown" }
  | { kind: "agendaItem"; number: string | null; title: string }
  | { kind: "agendaItemUnknown" }
  | { kind: "decision" }
  | { kind: "other" };

/** An agenda row as the viewer reads it: its number and title. */
export interface LiveVoteAgendaRow {
  item: { id: string; title: string };
  /** Null for an item that is not in the agenda for everyone yet. */
  number: string | null;
}

/**
 * What the vote was about: an amendment (by code, when it is among the
 * amendments the viewer can read), the final vote of the document shown, an
 * agenda item (by its number and title in the viewer's own agenda, which
 * says what the viewer may read of it), a decision of the Mesa, or
 * something else.
 */
export function liveVoteSubject(
  /** A recorded vote, or the secret vote being counted (LiveTally). */
  vote: { subjectType: VoteSubject; subjectId: string | null },
  context: {
    amendments: readonly AmendmentDto[];
    document: { id: string; title: string; reference: string | null } | null;
    /** The viewer's agenda rows, numbered (buildSessionAgendaRows). */
    agenda?: readonly LiveVoteAgendaRow[];
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
    case "agenda_item": {
      const row = context.agenda?.find(
        (item) => item.item.id === vote.subjectId,
      );
      return row
        ? { kind: "agendaItem", number: row.number, title: row.item.title }
        : { kind: "agendaItemUnknown" };
    }
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
    case "agendaItem":
      return t("projection.vote.agendaItem", {
        title: numberedAgendaTitle(
          subject.number,
          subject.title,
          t("agenda.unlisted.inText"),
        ),
      });
    case "agendaItemUnknown":
      return t("projection.vote.agendaItemUnknown");
    case "decision":
      return t("projection.vote.decision");
    default:
      return t("projection.vote.other");
  }
}

/** Spaces collapsed and case ignored, to compare two short texts. */
function sameText(a: string, b: string): boolean {
  const plain = (text: string) =>
    text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return plain(a) === plain(b);
}

/**
 * What an agenda item vote decided, as the Mesa wrote it ("Qué se vota"),
 * to show under its heading. Null when there is none, or when it only
 * repeats the item's title the heading already names (the console offers
 * the numbered title as it).
 */
export function liveVoteQuestion(
  vote: Pick<VoteDto, "question">,
  subject: LiveVoteSubject,
  unlistedMark: string,
): string | null {
  const question = vote.question?.trim();
  if (!question) return null;
  if (subject.kind === "agendaItem") {
    const repeats = [
      subject.title,
      numberedAgendaTitle(subject.number, subject.title, unlistedMark),
    ].some((title) => sameText(title, question));
    if (repeats) return null;
  }
  return question;
}

/**
 * The line an assent vote shows instead of counts: "Por unanimidad" when
 * nobody objected once unanimity was asked, else "Por asentimiento". Null
 * for a counted vote.
 */
export function liveAssentKey(
  vote: Pick<VoteDto, "method" | "unanimous">,
): string | null {
  if (vote.method !== "assent") return null;
  return vote.unanimous
    ? "projection.vote.unanimous"
    : "session.enums.approvalMethod.assent";
}

/**
 * Whether a batch of live events changed the vote on screen itself: the
 * live state still points at it, but its unanimity changed (an event of
 * entity `vote` with its id), so the screens read the live state again.
 */
export function affectsLiveVote(
  events: readonly LiveEventDto[],
  voteId: string | null | undefined,
): boolean {
  return (
    Boolean(voteId) &&
    events.some(
      (event) => event.entityType === "vote" && event.entityId === voteId,
    )
  );
}

export type LiveVoteCountKey =
  "inFavor" | "against" | "abstentions" | "blank" | "invalid" | "notCast";

/**
 * The counts to show (shownVoteCounts): abstentions, or blank ballots in a
 * secret vote; invalid ones and those who cast nothing only when there
 * were any.
 */
export function liveVoteCounts(
  vote: VoteDto,
): { key: LiveVoteCountKey; value: number }[] {
  const counts = shownVoteCounts(vote);
  // A vote between alternatives counts each option instead, and an
  // election each candidate.
  return (vote.options && vote.options.length > 0) || vote.election
    ? counts.filter((row) => row.key !== "inFavor" && row.key !== "against")
    : counts;
}

// A secret vote being counted --------------------------------------------------

/** The ballots of a secret vote, in the order the projection shows them. */
export const LIVE_TALLY_KEYS = [
  "inFavor",
  "against",
  "blank",
  "invalid",
] as const satisfies readonly (keyof LiveTallyCounts)[];

/**
 * The running count of a secret vote shown ballot by ballot, each with its
 * share of the largest one (the bars); empty when the count is only shown
 * with the result (`reveal: "end"`, no counts).
 */
export function liveTallyRows(
  tally: Pick<LiveTally, "counts" | "options"> | null | undefined,
): {
  /** A ballot key, or `option` with its index in a vote between alternatives. */
  key: (typeof LIVE_TALLY_KEYS)[number] | "option";
  option: number | null;
  count: number;
  share: number;
}[] {
  const counts = tally?.counts;
  if (!counts) return [];
  // Between alternatives: each option, then blank and invalid ballots.
  const rows =
    tally?.options && tally.options.length > 0
      ? [
          ...tally.options.map((count, option) => ({
            key: "option" as const,
            option,
            count,
          })),
          { key: "blank" as const, option: null, count: counts.blank },
          { key: "invalid" as const, option: null, count: counts.invalid },
        ]
      : LIVE_TALLY_KEYS.map((key) => ({
          key,
          option: null,
          count: counts[key],
        }));
  const top = Math.max(1, ...rows.map((row) => row.count));
  return rows.map((row) => ({ ...row, share: row.count / top }));
}

/** The ballots counted so far; 0 without a running count. */
export function liveTallyCast(
  tally: Pick<LiveTally, "counts" | "options"> | null | undefined,
): number {
  const counts = tally?.counts;
  const options = (tally?.options ?? []).reduce((sum, count) => sum + count, 0);
  return counts
    ? LIVE_TALLY_KEYS.reduce((sum, key) => sum + counts[key], 0) + options
    : 0;
}
