/**
 * Pure helpers that turn GET /api/me/work into what the home page and the
 * assembly overview show: the things a user has to do (present an expected
 * document, fix what the Secretaría sent back, send a draft, answer a
 * transactional over their amendment, answer the amendments to a document
 * they present), where the rest of their documents and amendments stand
 * and the Secretaría's pending review per assembly; and GET
 * /api/me/notices into what others decided about them, in words («Avisos»,
 * ShellNotices). No Vue or Nuxt here.
 *
 * The "-" prefix keeps Nuxt from registering this module (and its test) as
 * a component; import it explicitly.
 */
import type { AmendmentKind } from "~~/shared/constants/domain";
import type {
  MeWorkAcceptanceDto,
  MeWorkAmendmentDto,
  MeWorkAssemblyRef,
  MeWorkDocumentDto,
  MeWorkDto,
  MeWorkNewsDto,
  MeWorkProponentDto,
  MeWorkReviewDto,
} from "~~/shared/types/api";
import { dedupeNews } from "~~/shared/utils/notices";
import { compareAmendmentCodes } from "~/composables/amendment/workspace";

/** Something the user has to do, in the order it is most urgent. */
export type HomeWorkTaskKind =
  /** The Secretaría sent the document back with a note. */
  | "document_correction"
  /** An expected (or new) document with no text or PDF yet. */
  | "document_prepare"
  /** A draft with content that was never sent to the Secretaría. */
  | "document_send"
  /** The Secretaría sent the amendment back with a note. */
  | "amendment_correction"
  /**
   * A transactional would replace the user's amendment: as its main author,
   * the user accepts or rejects it.
   */
  | "transactional_answer"
  /**
   * A published document the user's member presents (as main presenter) has
   * amendments it has not answered yet.
   */
  | "proponent_review"
  /** An amendment draft never presented. */
  | "amendment_draft";

/**
 * Where something the user does not have to act on stands. GET /api/me/work
 * only returns drafts, presented and published documents, and amendments
 * not decided yet.
 */
export type HomeWorkUpdateKind =
  /**
   * A draft past its presentation deadline: only the Secretaría may present
   * it late, so it is no task (MeWorkDocumentDto.presentationClosedAt).
   * Never a report, which never closes for members (closesForMembers).
   */
  | "document_closed"
  | "document_review"
  | "document_published"
  /** A transactional the user proposed, waiting for the main authors. */
  | "amendment_authors"
  | "amendment_review"
  /** Late: the assembly has not decided whether to treat it yet. */
  | "amendment_late"
  | "amendment_validated"
  | "amendment_published"
  | "amendment_other";

export interface HomeWorkDocumentRef {
  id: string;
  slug: string;
  title: string;
}

export interface HomeWorkAmendmentRef {
  id: string;
  /** Null until it is published (numbered then). */
  code: string | null;
  /** Names a transactional before it has a code. */
  kind?: AmendmentKind;
}

/** What waits for the main presenter of a document (`proponent_review`). */
export interface HomeWorkProponentCounts {
  /** Undecided amendments with no answer from the main presenter yet. */
  positions: number;
}

export interface HomeWorkTask {
  /** Unique across documents and amendments. */
  key: string;
  kind: HomeWorkTaskKind;
  assembly: MeWorkAssemblyRef;
  document: HomeWorkDocumentRef;
  /** The amendment, or the transactional to answer. */
  amendment: HomeWorkAmendmentRef | null;
  /** Only for `transactional_answer`: the user's amendments it replaces. */
  replaces: HomeWorkAmendmentRef[];
  /** Only for `transactional_answer`: acronym of the member proposing it. */
  proposedBy?: string | null;
  /** Only for `proponent_review`: what is waiting; null otherwise. */
  counts: HomeWorkProponentCounts | null;
  /** The Secretaría's note when it asked for a correction. */
  note: string | null;
  /**
   * Internal deadline of an expected document; for `proponent_review`, the
   * start of the assembly while it is ahead (homeWorkProponentDueAt).
   */
  dueAt: string | null;
  /** The deadline has passed and the document was not presented. */
  overdue: boolean;
  /**
   * Where it is done: the document editor, the document workspace (with
   * the amendment open), or the presenter's review of the amendments.
   */
  target: "edit" | "document" | "review";
}

export interface HomeWorkUpdate {
  key: string;
  kind: HomeWorkUpdateKind;
  assembly: MeWorkAssemblyRef;
  document: HomeWorkDocumentRef;
  amendment: (HomeWorkAmendmentRef & { status: string }) | null;
  /** Only for `document_closed`: the deadline that passed. */
  closed?: { at: string };
}

function documentRef(entry: MeWorkDocumentDto): HomeWorkDocumentRef {
  return {
    id: entry.document.id,
    slug: entry.document.slug,
    title: entry.document.title,
  };
}

function time(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** What the user has to do with one of their documents, if anything. */
export function homeWorkDocumentTask(
  entry: MeWorkDocumentDto,
): HomeWorkTaskKind | null {
  const document = entry.document;
  if (document.status !== "draft") return null;
  // Past its deadline: an update (document_closed), not a task.
  if (entry.presentationClosedAt) return null;
  if (document.correctionRequestedAt || document.correctionNote) {
    return "document_correction";
  }
  return document.hasContent ? "document_send" : "document_prepare";
}

/** What the user has to do with one of their amendments, if anything. */
export function homeWorkAmendmentTask(
  entry: MeWorkAmendmentDto,
): HomeWorkTaskKind | null {
  const amendment = entry.amendment;
  if (amendment.status !== "draft") return null;
  return amendment.reviewState === "correction_requested" ||
    amendment.correctionNote
    ? "amendment_correction"
    : "amendment_draft";
}

/** What the main presenter of a document has to answer, if anything. */
export function homeWorkProponentCounts(
  entry: MeWorkProponentDto,
): HomeWorkProponentCounts | null {
  const positions = Math.max(0, entry.positionsPending);
  return positions > 0 ? { positions } : null;
}

/**
 * By when the main presenter should answer: the start of the assembly
 * (`answerBy`), while it is still ahead. Null once the assembly is in
 * session or its start has passed: the answers are still welcome, but
 * there is no deadline left to count down to.
 */
export function homeWorkProponentDueAt(
  entry: MeWorkProponentDto,
  now: number,
): string | null {
  const at = time(entry.answerBy);
  return at !== null && at > now ? entry.answerBy : null;
}

const TASK_RANK: Record<HomeWorkTaskKind, number> = {
  document_correction: 0,
  amendment_correction: 0,
  transactional_answer: 1,
  proponent_review: 2,
  document_prepare: 3,
  document_send: 3,
  amendment_draft: 4,
};

function acceptanceTask(entry: MeWorkAcceptanceDto): HomeWorkTask {
  return {
    key: `acceptance-${entry.transactional.id}`,
    kind: "transactional_answer",
    assembly: entry.assembly,
    document: { ...entry.document },
    amendment: { ...entry.transactional },
    replaces: entry.replaces.map((amendment) => ({ ...amendment })),
    proposedBy: entry.proposedBy?.acronym ?? null,
    counts: null,
    note: null,
    dueAt: null,
    overdue: false,
    target: "document",
  };
}

/**
 * Everything the user has to do, most urgent first: corrections the
 * Secretaría asked for, then the transactionals waiting for the user's
 * answer (they hold up the amendments they would replace), then the
 * amendments to answer as the main presenter of a document, then overdue
 * documents, then the rest by deadline (documents without one after those
 * with one), then amendment drafts.
 */
export function homeWorkTasks(work: MeWorkDto, now: number): HomeWorkTask[] {
  const tasks: HomeWorkTask[] = [];
  for (const entry of work.documents) {
    const kind = homeWorkDocumentTask(entry);
    if (!kind) continue;
    const due = time(entry.document.dueAt);
    tasks.push({
      key: `document-${entry.document.id}`,
      kind,
      assembly: entry.assembly,
      document: documentRef(entry),
      amendment: null,
      replaces: [],
      counts: null,
      note:
        kind === "document_correction" ? entry.document.correctionNote : null,
      dueAt: entry.document.dueAt,
      overdue: due !== null && due < now,
      target: "edit",
    });
  }
  for (const entry of work.acceptances) tasks.push(acceptanceTask(entry));
  for (const entry of work.proponent) {
    const counts = homeWorkProponentCounts(entry);
    if (!counts) continue;
    tasks.push({
      key: `proponent-${entry.document.id}`,
      kind: "proponent_review",
      assembly: entry.assembly,
      document: { ...entry.document },
      amendment: null,
      replaces: [],
      counts,
      note: null,
      // Before the assembly starts; never overdue: once it has started the
      // line goes and the Mesa can still take the answers in the room.
      dueAt: homeWorkProponentDueAt(entry, now),
      overdue: false,
      target: "review",
    });
  }
  for (const entry of work.amendments) {
    const kind = homeWorkAmendmentTask(entry);
    if (!kind) continue;
    tasks.push({
      key: `amendment-${entry.amendment.id}`,
      kind,
      assembly: entry.assembly,
      document: { ...entry.document },
      amendment: { id: entry.amendment.id, code: entry.amendment.code },
      replaces: [],
      counts: null,
      note:
        kind === "amendment_correction" ? entry.amendment.correctionNote : null,
      dueAt: null,
      overdue: false,
      target: "document",
    });
  }
  return tasks.sort((a, b) => {
    const rank = TASK_RANK[a.kind] - TASK_RANK[b.kind];
    if (rank !== 0) return rank;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const dueA = time(a.dueAt) ?? Number.POSITIVE_INFINITY;
    const dueB = time(b.dueAt) ?? Number.POSITIVE_INFINITY;
    if (dueA !== dueB) return dueA - dueB;
    return (
      a.assembly.label.localeCompare(b.assembly.label) ||
      a.document.title.localeCompare(b.document.title) ||
      compareAmendmentCodes(a.amendment?.code, b.amendment?.code) ||
      a.key.localeCompare(b.key)
    );
  });
}

function documentUpdate(entry: MeWorkDocumentDto): HomeWorkUpdateKind | null {
  switch (entry.document.status) {
    case "draft":
      return entry.presentationClosedAt ? "document_closed" : null;
    case "submitted":
      return "document_review";
    case "published":
      return "document_published";
    default:
      return null;
  }
}

function amendmentUpdate(entry: MeWorkAmendmentDto): HomeWorkUpdateKind | null {
  const amendment = entry.amendment;
  if (amendment.status === "draft") return null;
  if (amendment.status !== "submitted") return "amendment_other";
  switch (amendment.reviewState) {
    case "pending_authors":
      return "amendment_authors";
    case "pending_validation":
      return "amendment_review";
    case "validated":
    case "published":
      // Checked by the Secretaría but late: the assembly decides first
      // whether to treat it.
      if (amendment.late && amendment.admission === "pending") {
        return "amendment_late";
      }
      return amendment.reviewState === "validated"
        ? "amendment_validated"
        : "amendment_published";
    default:
      return "amendment_other";
  }
}

const UPDATE_RANK: Record<HomeWorkUpdateKind, number> = {
  document_review: 0,
  document_closed: 1,
  amendment_authors: 0,
  amendment_review: 0,
  amendment_late: 1,
  amendment_validated: 1,
  document_published: 2,
  amendment_published: 2,
  amendment_other: 3,
};

/**
 * Where the user's documents and amendments stand when there is nothing
 * for them to do: waiting for someone first (the Secretaría, the main
 * authors of what a transactional replaces), then drafts past their
 * deadline, late ones waiting for the assembly and validated ones, then
 * published. A published document
 * whose amendments wait for the user's answer is left out: it is already a
 * task.
 */
export function homeWorkUpdates(work: MeWorkDto): HomeWorkUpdate[] {
  const answering = new Set(
    work.proponent
      .filter((entry) => homeWorkProponentCounts(entry))
      .map((entry) => entry.document.id),
  );
  const updates: HomeWorkUpdate[] = [];
  for (const entry of work.documents) {
    const kind = documentUpdate(entry);
    if (!kind) continue;
    if (kind === "document_published" && answering.has(entry.document.id)) {
      continue;
    }
    updates.push({
      key: `document-${entry.document.id}`,
      kind,
      assembly: entry.assembly,
      document: documentRef(entry),
      amendment: null,
      ...(kind === "document_closed" && entry.presentationClosedAt
        ? { closed: { at: entry.presentationClosedAt } }
        : {}),
    });
  }
  for (const entry of work.amendments) {
    const kind = amendmentUpdate(entry);
    if (!kind) continue;
    updates.push({
      key: `amendment-${entry.amendment.id}`,
      kind,
      assembly: entry.assembly,
      document: { ...entry.document },
      amendment: {
        id: entry.amendment.id,
        code: entry.amendment.code,
        status: entry.amendment.status,
      },
    });
  }
  return updates.sort(
    (a, b) =>
      UPDATE_RANK[a.kind] - UPDATE_RANK[b.kind] ||
      a.assembly.label.localeCompare(b.assembly.label) ||
      a.document.title.localeCompare(b.document.title) ||
      (a.amendment ? 1 : 0) - (b.amendment ? 1 : 0) ||
      compareAmendmentCodes(a.amendment?.code, b.amendment?.code) ||
      a.key.localeCompare(b.key),
  );
}

// News -------------------------------------------------------------------------

/** An i18n key and its parameters, still to be translated. */
export interface HomeWorkPhrase {
  key: string;
  params: Record<string, string>;
}

/**
 * Who decided, as a sentence names them: a phrase to translate ("UPV,
 * proponente principal,") or just the member's acronym.
 */
export type HomeWorkWho = HomeWorkPhrase | { name: string };

/**
 * A decision someone else took about the user's work, in words:
 * `sentence` is translated with `who` and `amendment` translated first and
 * passed in as the parameters of the same name.
 */
export interface HomeWorkNews {
  key: string;
  assembly: MeWorkAssemblyRef;
  document: HomeWorkDocumentRef;
  amendment: HomeWorkAmendmentRef | null;
  sentence: HomeWorkPhrase;
  /** Who decided, when the sentence names it. */
  who: HomeWorkWho | null;
  /**
   * The amendment as the sentence names it ("tu enmienda CEUM 2"), or, for
   * a group, how many ("12 enmiendas").
   */
  phrase: HomeWorkPhrase | null;
  /**
   * For a group (MeWorkNewsDto.count), the codes it names ("UGR1, UGR2,
   * UGR3 y 9 más", or just the codes when it names them all), passed in as
   * the parameter `codes`; null otherwise.
   */
  codes: HomeWorkPhrase | { name: string } | null;
  /** Tone of its icon: good news, bad news or neutral. */
  tone: "success" | "error" | "neutral";
  /**
   * Where the sentence leads: the document with the amendment open, or the
   * review of the main presenter's answers: read-only for a co-presenter
   * reading the main presenter's answer to an amendment of someone else,
   * and where the main presenter answers a new amendment still waiting for
   * it (MeWorkNewsDto.awaitsAnswer).
   */
  target: "document" | "review";
  /**
   * The Admin who did it while acting as the user's account (the user did
   * not decide it), by name; null otherwise.
   */
  impersonatedBy: string | null;
  at: string;
  /**
   * MeWorkNewsDto.visibleAt: when it reached the reader, if later than
   * `at`. The notices' panel splits «Nuevos» by it (noticeMoment).
   */
  visibleAt?: string;
}

const POSITION_VALUES = new Set(["accept", "reject", "transact", "pending"]);

/** Transactionals are numbered apart: `T1`, `T2`... (docs/design.md). */
export function isHomeWorkTransactionalCode(code: string | null): boolean {
  return code !== null && /^T\d+$/.test(code);
}

/**
 * How a sentence names the amendment: "tu enmienda CEUM 2", "la enmienda
 * CEUM 2", "tu transaccional T2", "la transaccional T2", or "una enmienda"
 * ("una transaccional") before it has a code.
 */
function amendmentPhrase(
  amendment: HomeWorkAmendmentRef | null,
  own: boolean,
  transactional = false,
): HomeWorkPhrase | null {
  if (!amendment) return null;
  if (!amendment.code) {
    return {
      key: transactional
        ? "home.news.phrase.someTransactional"
        : "home.news.phrase.someAmendment",
      params: {},
    };
  }
  const key = transactional
    ? own
      ? "home.news.phrase.yourTransactional"
      : "home.news.phrase.transactional"
    : own
      ? "home.news.phrase.yourAmendment"
      : "home.news.phrase.amendment";
  return { key, params: { code: amendment.code } };
}

/**
 * Puts one news entry into words: what happened, who did it when the
 * sentence names someone, how the amendment is named ("tu enmienda" when
 * the server says the user's member authored it, `ownAmendment`) and where
 * the sentence leads. Unknown event types get a general sentence.
 */
export function homeWorkNewsItem(news: MeWorkNewsDto): HomeWorkNews {
  const amendment = news.amendment ? { ...news.amendment } : null;
  const mine = amendment !== null && news.ownAmendment === true;
  const transactional =
    amendment?.kind === "transactional" ||
    isHomeWorkTransactionalCode(amendment?.code ?? null);
  const by = news.by?.acronym ?? null;
  const base = {
    key: news.id,
    assembly: news.assembly,
    document: { ...news.document },
    amendment,
    impersonatedBy: news.impersonatedBy?.name ?? null,
    at: news.at,
    ...(news.visibleAt ? { visibleAt: news.visibleAt } : {}),
    codes: null,
  };
  if (news.count !== undefined && news.count > 1) {
    return homeWorkNewsGroup(news, base);
  }
  const phrase = amendmentPhrase(amendment, mine, transactional);
  const make = (
    key: string,
    tone: HomeWorkNews["tone"] = "neutral",
    who: HomeWorkWho | null = null,
    named: HomeWorkPhrase | null = phrase,
    params: Record<string, string> = {},
    target: HomeWorkNews["target"] = "document",
  ): HomeWorkNews => ({
    ...base,
    sentence: { key, params },
    who,
    phrase: named,
    tone,
    target,
  });

  if (news.asMesa) {
    const mesa = homeWorkMesaSentence(news);
    return make(mesa.key, mesa.tone, mesa.named && by ? { name: by } : null);
  }

  switch (news.type) {
    case "position_changed": {
      const value =
        news.value && POSITION_VALUES.has(news.value) ? news.value : "pending";
      // A formal amendment answered by itself, or back to unanswered once
      // it stopped being formal: nobody to name.
      if (news.automatic) {
        return value === "accept"
          ? make(
              "home.news.position.autoAccept",
              "success",
              null,
              phrase,
              {},
              mine ? "document" : "review",
            )
          : make(
              "home.news.position.autoPending",
              "neutral",
              null,
              phrase,
              {},
              mine ? "document" : "review",
            );
      }
      const who: HomeWorkPhrase = by
        ? { key: "home.news.who.mainPresenter", params: { member: by } }
        : { key: "home.news.who.mainPresenterUnknown", params: {} };
      const tone =
        value === "accept"
          ? "success"
          : value === "reject"
            ? "error"
            : "neutral";
      // Not the member's amendment: it co-presents the document, and reads
      // the main presenter's answers in the review, without answering.
      return make(
        `home.news.position.${value}`,
        tone,
        who,
        phrase,
        {},
        mine ? "document" : "review",
      );
    }
    case "acceptance_recorded": {
      const who: HomeWorkWho = by
        ? { name: by }
        : { key: "home.news.who.mainAuthorUnknown", params: {} };
      // Always a transactional: one the member proposed ("tu
      // transaccional"), or one over an amendment of the member, which the
      // sentence says what it means for ("sigue tu enmienda").
      const named = amendmentPhrase(amendment, mine, true);
      if (news.value === "rejected") {
        return mine
          ? make("home.news.acceptance.rejected", "error", who, named)
          : make(
              "home.news.acceptance.rejectedOverYours",
              "neutral",
              who,
              named,
            );
      }
      if (news.value === "accepted") {
        return mine
          ? make("home.news.acceptance.accepted", "success", who, named)
          : make(
              "home.news.acceptance.acceptedOverYours",
              "neutral",
              who,
              named,
            );
      }
      return make("home.news.acceptance.pending", "neutral", who, named);
    }
    case "amendment_approved":
      // Accepted by the document's main presenter, in a document that
      // incorporates accepted amendments: named when known.
      if (news.value === "proponent") {
        // A formal amendment accepted by itself.
        if (news.automatic) {
          return make("home.news.amendment.incorporatedAuto", "success");
        }
        return by
          ? make("home.news.amendment.incorporatedBy", "success", {
              key: "home.news.who.mainPresenter",
              params: { member: by },
            })
          : make("home.news.amendment.incorporated", "success");
      }
      return make("home.news.amendment.approved", "success");
    case "amendment_rejected":
      return news.value === "proponent"
        ? make("home.news.amendment.rejectedByPresenter", "error")
        : make("home.news.amendment.rejected", "error");
    case "amendment_validated":
    case "amendment_published":
      // New to a document the member presents: once, whichever let it read
      // it first. The main presenter answers it in the review.
      if (news.asPresenter) {
        return news.awaitsAnswer
          ? make(
              "home.news.amendment.arrivedAwaiting",
              "neutral",
              null,
              phrase,
              {},
              "review",
            )
          : make("home.news.amendment.arrived");
      }
      if (news.type === "amendment_published") {
        return make("home.news.amendment.published");
      }
      // Validated but late: the assembly still decides whether to treat it.
      return news.value === "pending"
        ? make("home.news.amendment.validatedLate")
        : make("home.news.amendment.validated");
    case "amendment_correction_requested":
      return make("home.news.amendment.correction");
    case "amendment_validation_undone":
      // The Secretaría took its validation back: it reviews it again.
      return make("home.news.amendment.validationUndone");
    case "amendment_reclassified":
      // The Secretaría moved it between "de forma" and "de contenido".
      return news.value === "formal"
        ? make("home.news.amendment.reclassifiedFormal")
        : make("home.news.amendment.reclassifiedContent");
    case "amendment_authors_changed":
      // The Secretaría corrected who presents it.
      return make("home.news.amendment.authorsChanged");
    case "amendment_admitted":
      return make("home.news.amendment.admitted", "success");
    case "amendment_inadmissible":
      // Not admitted by the Secretaría while reviewing it: no correction.
      return news.value === "review"
        ? make("home.news.amendment.inadmissibleReview", "error")
        : make("home.news.amendment.inadmissible", "error");
    case "amendment_transacted":
      // Named after the transactional that replaced it, when known.
      return news.value
        ? make("home.news.amendment.transactedBy", "neutral", null, phrase, {
            code: news.value,
          })
        : make("home.news.amendment.transacted");
    case "amendment_lapsed":
      // A transactional the Mesa lapsed after it replaced the reader's
      // amendment (value "replaced"): that amendment stays replaced. Its
      // own authors, and the document's presenters, read the plain lapse.
      if (news.value === "replaced") {
        return news.ownAmendment || news.asPresenter
          ? make("home.news.amendment.lapsed")
          : make("home.news.amendment.lapsedReplacing");
      }
      // A transactional left behind because another one replaced its
      // amendments first: the value names that one.
      return news.value
        ? make("home.news.amendment.lapsedBy", "neutral", null, phrase, {
            code: news.value,
          })
        : make("home.news.amendment.lapsed");
    case "amendment_withdrawn":
      // A transactional withdrawn after it replaced the reader's amendment
      // (value "replaced"): that amendment stays replaced. Its own authors,
      // and the document's presenters, read the plain withdrawal.
      if (
        news.value === "replaced" &&
        !news.ownAmendment &&
        !news.asPresenter
      ) {
        return make("home.news.amendment.withdrawnReplacing");
      }
      // A transactional closed on its own, not withdrawn by anyone: an
      // amendment it groups was settled first, and the value names it. Its
      // proposer and its parties read it ("tu transaccional", "la
      // transaccional").
      return news.value && news.value !== "replaced"
        ? make("home.news.amendment.closedBy", "neutral", null, phrase, {
            code: news.value,
          })
        : make("home.news.amendment.withdrawn");
    case "amendment_reopened":
      // A transactional back on its own: the amendment whose settling had
      // closed it was reopened, and the value names it.
      return news.value
        ? make("home.news.amendment.restoredBy", "neutral", null, phrase, {
            code: news.value,
          })
        : make("home.news.amendment.reopened");
    case "document_published":
      return make("home.news.document.published", "success");
    case "document_correction_requested":
      return make("home.news.document.correction");
    case "document_voted":
      if (news.value === "rejected") {
        return make("home.news.document.rejected", "error");
      }
      // Approved pending conciliation (user's decisions of 2026-11-21).
      return news.value === "approved_pending"
        ? make("home.news.document.approvedPending", "success")
        : make("home.news.document.approved", "success");
    case "document_status_changed":
      if (news.value === "withdrawn" || news.value === "postponed") {
        return make(`home.work.updates.document_${news.value}`);
      }
      return make("home.news.document.other");
    default:
      return amendment
        ? make("home.news.amendment.other")
        : make("home.news.document.other");
  }
}

/**
 * What a Mesa's row (MeWorkNewsDto.asMesa) says about one amendment: its
 * validation, a transactional every party accepted (`ready`) or with an
 * inclusion every party accepted, a party's rejection (naming the party)
 * or a withdrawal by its author (naming the author). `named`: the sentence
 * names who did it (`who`), when known.
 */
function homeWorkMesaSentence(news: MeWorkNewsDto): {
  key: string;
  tone: HomeWorkNews["tone"];
  named: boolean;
} {
  const plain = (key: string, tone: HomeWorkNews["tone"] = "neutral") => ({
    key,
    tone,
    named: false,
  });
  const by = news.by !== null;
  switch (news.type) {
    case "amendment_validated":
      return news.value === "pending"
        ? plain("home.news.amendment.validatedLate")
        : plain("home.news.amendment.validated");
    case "transactional_revision_ready":
      return plain("home.news.mesa.revisionReady");
    case "amendment_withdrawn":
      return by
        ? {
            key: "home.news.mesa.withdrawnByAuthor",
            tone: "neutral",
            named: true,
          }
        : plain("home.news.amendment.withdrawn");
    case "acceptance_recorded":
      if (news.value === "rejected") {
        return by
          ? { key: "home.news.acceptance.rejected", tone: "error", named: true }
          : plain("home.news.mesa.rejected", "error");
      }
      return plain("home.news.mesa.ready", "success");
    case "amendment_submitted":
      return plain("home.news.mesa.ready", "success");
    default:
      return plain("home.news.amendment.other");
  }
}

/**
 * A group of the Mesa's rows (MeWorkNewsDto.asMesa with `count`): the
 * sentence for its kind, with no one named. Late validations group apart
 * (newsRunKey), so `value` "pending" is every one's.
 */
function homeWorkMesaGroupKey(news: MeWorkNewsDto): string {
  switch (news.type) {
    case "amendment_validated":
      return news.value === "pending"
        ? "home.news.mesa.group.validatedLate"
        : "home.news.mesa.group.validated";
    case "amendment_withdrawn":
      return "home.news.mesa.group.withdrawn";
    case "transactional_revision_ready":
      return "home.news.mesa.group.revisionReady";
    case "acceptance_recorded":
    case "amendment_submitted":
      return news.value === "ready"
        ? "home.news.mesa.group.ready"
        : "home.news.group.other";
    default:
      return "home.news.group.other";
  }
}

/**
 * A group of presenters' or Mesa's rows (MeWorkNewsDto.count) in words: how
 * many amendments ("12 enmiendas", "3 transaccionales") with their first
 * codes, what happened to them, and, while one still waits for the main
 * presenter's answer, the review. The context names the document, since
 * there is no single amendment to open.
 */
function homeWorkNewsGroup(
  news: MeWorkNewsDto,
  base: Omit<HomeWorkNews, "sentence" | "who" | "phrase" | "tone" | "target">,
): HomeWorkNews {
  const count = news.count ?? 0;
  const listed = news.amendments ?? [];
  const codes = listed
    .map((item) => item.code)
    .filter((code): code is string => code !== null);
  const transactional =
    listed.length > 0 &&
    listed.every(
      (item) =>
        item.kind === "transactional" || isHomeWorkTransactionalCode(item.code),
    );
  const rest = String(count - codes.length);
  const make = (
    key: string,
    params: Record<string, string> = {},
    target: HomeWorkNews["target"] = "document",
  ): HomeWorkNews => ({
    ...base,
    amendment: null,
    sentence: { key, params },
    who: null,
    phrase: {
      key: transactional
        ? "home.news.group.transactionals"
        : "home.news.group.amendments",
      params: { count: String(count) },
    },
    codes:
      codes.length === 0
        ? { key: "home.news.group.codesNone", params: {} }
        : codes.length < count
          ? {
              key: "home.news.group.codesMore",
              params: { codes: codes.join(", "), rest },
            }
          : { name: codes.join(", ") },
    tone: "neutral",
    target,
  });
  // The Mesa's runs: no document of the reader's, no answer due.
  if (news.asMesa) return make(homeWorkMesaGroupKey(news));
  switch (news.type) {
    case "amendment_validated":
    case "amendment_published":
      return news.awaitsAnswer
        ? make("home.news.group.arrivedAwaiting", {}, "review")
        : make("home.news.group.arrived");
    case "amendment_withdrawn":
      // Transactionals closed by themselves: the amendment named, which
      // they grouped, was settled (`by: "sources_closed"`).
      return news.value && news.value !== "replaced"
        ? make("home.news.group.closedBy", { code: news.value })
        : make("home.news.group.withdrawn");
    case "amendment_lapsed":
      // Left behind because the transactional named already replaced them.
      return news.value && news.value !== "replaced"
        ? make("home.news.group.lapsedBy", { code: news.value })
        : make("home.news.group.lapsed");
    case "amendment_transacted":
      return news.value
        ? make("home.news.group.transactedBy", { code: news.value })
        : make("home.news.group.transacted");
    default:
      return make("home.news.group.other");
  }
}

/**
 * The notices (GET /api/me/notices `items`), latest first, in words
 * (homeWorkNewsItem), without the rows one decision produced twice
 * (dedupeNews, shared with the server, which counts the new notices on the
 * same rows).
 */
export function homeWorkNews(news: MeWorkNewsDto[]): HomeWorkNews[] {
  return dedupeNews(news)
    .map((news) => homeWorkNewsItem(news))
    .sort(
      (a, b) =>
        (time(b.at) ?? 0) - (time(a.at) ?? 0) || a.key.localeCompare(b.key),
    );
}

// Review -------------------------------------------------------------------------

/** Everything waiting for the Secretaría in one assembly. */
export function homeWorkReviewTotal(review: MeWorkReviewDto): number {
  return (
    review.documentsToValidate +
    review.amendmentsToValidate +
    review.amendmentsToPublish +
    review.documentsOverdue
  );
}

/** The assemblies with something waiting for the Secretaría. */
export function homeWorkReviewPending(
  review: MeWorkReviewDto[],
): MeWorkReviewDto[] {
  return review.filter((entry) => homeWorkReviewTotal(entry) > 0);
}

/** The part of the user's work that belongs to one assembly. */
export function homeWorkForAssembly(
  work: MeWorkDto,
  assemblyId: string,
): MeWorkDto {
  const here = (entry: { assembly: MeWorkAssemblyRef }) =>
    entry.assembly.id === assemblyId;
  return {
    documents: work.documents.filter(here),
    amendments: work.amendments.filter(here),
    review: work.review.filter(here),
    proponent: work.proponent.filter(here),
    acceptances: work.acceptances.filter(here),
    news: [],
  };
}

/**
 * Query string that opens an amendment in the document workspace
 * (`?enmienda=<id>`), so a task or an update lands on it; empty for a
 * document.
 */
export function homeWorkAmendmentQuery(
  amendment: { id: string } | null,
): string {
  return amendment ? `?enmienda=${encodeURIComponent(amendment.id)}` : "";
}

/**
 * What follows the document's path where a news item leads: the read-only
 * review of the main presenter's answers on that amendment
 * (`/revisar?enmienda=<id>`), or the document with the amendment open
 * (`?enmienda=<id>`, empty for a document's news).
 */
export function homeWorkNewsLink(
  item: Pick<HomeWorkNews, "target" | "amendment">,
): string {
  const query = homeWorkAmendmentQuery(item.amendment);
  return item.target === "review" ? `/revisar${query}` : query;
}

// Calendar -----------------------------------------------------------------------

/** What the home page needs of an assembly to say what comes next. */
export interface HomeDeadlineAssembly {
  status: string;
  nextMilestone: { at: string } | null;
}

/**
 * The assembly whose next calendar milestone comes first, among those not
 * closed: the one line of "Lo siguiente" on the home page. Milestones
 * already past (a list loaded a while ago) are left out; null when nothing
 * is ahead.
 */
export function homeNextDeadline<T extends HomeDeadlineAssembly>(
  assemblies: readonly T[],
  now: number,
): T | null {
  let best: T | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const assembly of assemblies) {
    if (assembly.status === "closed") continue;
    const at = time(assembly.nextMilestone?.at ?? null);
    if (at === null || at < now || at >= bestAt) continue;
    best = assembly;
    bestAt = at;
  }
  return best;
}
