/**
 * Pure helpers that turn GET /api/me/work into what the home page and the
 * assembly overview show: the things a user has to do (present an expected
 * document, fix what the Secretaría sent back, send a draft, answer a
 * transactional over their amendment, answer the amendments to a document
 * they present), where the rest of their documents and amendments stand,
 * what others decided about them ("Novedades"), and the Secretaría's
 * pending review per assembly. No Vue or Nuxt here.
 *
 * The "-" prefix keeps Nuxt from registering this module (and its test) as
 * a component; import it explicitly.
 */
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
  code: string | null;
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
  /** Only for `proponent_review`: what is waiting; null otherwise. */
  counts: HomeWorkProponentCounts | null;
  /** The Secretaría's note when it asked for a correction. */
  note: string | null;
  /** Internal deadline of an expected document. */
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
      dueAt: null,
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
      (a.amendment?.code ?? "").localeCompare(b.amendment?.code ?? "") ||
      a.key.localeCompare(b.key)
    );
  });
}

function documentUpdate(entry: MeWorkDocumentDto): HomeWorkUpdateKind | null {
  switch (entry.document.status) {
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
 * authors of what a transactional replaces), then late ones waiting for
 * the assembly and validated ones, then published. A published document
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
      (a.amendment?.code ?? "").localeCompare(b.amendment?.code ?? "") ||
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
  /** The amendment as the sentence names it ("tu enmienda CEUM 2"). */
  phrase: HomeWorkPhrase | null;
  /** Tone of its icon: good news, bad news or neutral. */
  tone: "success" | "error" | "neutral";
  /**
   * Where the sentence leads: the document with the amendment open, or,
   * for a co-presenter reading the main presenter's answer to an amendment
   * of someone else, the read-only review of those answers.
   */
  target: "document" | "review";
  /**
   * The Admin who did it while acting as the user's account (the user did
   * not decide it), by name; null otherwise.
   */
  impersonatedBy: string | null;
  at: string;
}

const POSITION_VALUES = new Set(["accept", "reject", "transact", "pending"]);

/** Transactionals are numbered apart: `T1`, `T2`... (docs/design.md). */
export function isHomeWorkTransactionalCode(code: string | null): boolean {
  return code !== null && /^T\d+$/.test(code);
}

/**
 * How a sentence names the amendment: "tu enmienda CEUM 2", "la enmienda
 * CEUM 2", "tu transaccional T2", "la transaccional T2", or "una enmienda"
 * before it has a code.
 */
function amendmentPhrase(
  amendment: HomeWorkAmendmentRef | null,
  own: boolean,
  transactional = false,
): HomeWorkPhrase | null {
  if (!amendment) return null;
  if (!amendment.code) {
    return { key: "home.news.phrase.someAmendment", params: {} };
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
  const transactional = isHomeWorkTransactionalCode(amendment?.code ?? null);
  const by = news.by?.acronym ?? null;
  const base = {
    key: news.id,
    assembly: news.assembly,
    document: { ...news.document },
    amendment,
    impersonatedBy: news.impersonatedBy?.name ?? null,
    at: news.at,
  };
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

  switch (news.type) {
    case "position_changed": {
      const value =
        news.value && POSITION_VALUES.has(news.value) ? news.value : "pending";
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
        return by
          ? make("home.news.amendment.incorporatedBy", "success", {
              key: "home.news.who.mainPresenter",
              params: { member: by },
            })
          : make("home.news.amendment.incorporated", "success");
      }
      return make("home.news.amendment.approved", "success");
    case "amendment_rejected":
      return make("home.news.amendment.rejected", "error");
    case "amendment_validated":
      // Validated but late: the assembly still decides whether to treat it.
      return news.value === "pending"
        ? make("home.news.amendment.validatedLate")
        : make("home.news.amendment.validated");
    case "amendment_published":
      return make("home.news.amendment.published");
    case "amendment_correction_requested":
      return make("home.news.amendment.correction");
    case "amendment_admitted":
      return make("home.news.amendment.admitted", "success");
    case "amendment_inadmissible":
      return make("home.news.amendment.inadmissible", "error");
    case "amendment_transacted":
      // Named after the transactional that replaced it, when known.
      return news.value
        ? make("home.news.amendment.transactedBy", "neutral", null, phrase, {
            code: news.value,
          })
        : make("home.news.amendment.transacted");
    case "amendment_lapsed":
      // A transactional left behind because another one replaced its
      // amendments first: the value names that one.
      return news.value
        ? make("home.news.amendment.lapsedBy", "neutral", null, phrase, {
            code: news.value,
          })
        : make("home.news.amendment.lapsed");
    case "amendment_withdrawn":
      // A transactional closed on its own, not withdrawn by anyone: an
      // amendment it groups was settled first, and the value names it. Its
      // proposer and its parties read it ("tu transaccional", "la
      // transaccional").
      return news.value
        ? make("home.news.amendment.closedBy", "neutral", null, phrase, {
            code: news.value,
          })
        : make("home.news.amendment.withdrawn");
    case "amendment_reopened":
      return make("home.news.amendment.reopened");
    case "document_published":
      return make("home.news.document.published", "success");
    case "document_correction_requested":
      return make("home.news.document.correction");
    case "document_voted":
      return news.value === "rejected"
        ? make("home.news.document.rejected", "error")
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
 * The news without the ones a single decision produced twice. Events
 * recorded together share their time, so two news about the same amendment
 * at the same instant come from one decision, and one sentence says it:
 * - a main author's rejection closes the transactional (it is withdrawn):
 *   the rejection says so, the withdrawal is dropped;
 * - the main presenter's acceptance incorporates the amendment: the
 *   incorporation names who accepted it, the answer is dropped;
 * - a new answer takes an incorporated amendment out again (it is
 *   reopened): the answer says so, the reopening is dropped.
 */
export function homeWorkNewsDeduped(list: MeWorkNewsDto[]): MeWorkNewsDto[] {
  const keyOf = (news: MeWorkNewsDto) =>
    news.amendment ? `${news.amendment.id}@${time(news.at) ?? news.at}` : null;
  const together = new Map<string, Set<string>>();
  for (const news of list) {
    const key = keyOf(news);
    if (!key) continue;
    const kinds = together.get(key) ?? new Set<string>();
    kinds.add(news.type);
    kinds.add(`${news.type}:${news.value ?? ""}`);
    together.set(key, kinds);
  }
  return list.filter((news) => {
    const key = keyOf(news);
    const kinds = key ? together.get(key) : undefined;
    if (!kinds) return true;
    switch (news.type) {
      case "amendment_withdrawn":
        return !kinds.has("acceptance_recorded:rejected");
      case "position_changed":
        return !(
          news.value === "accept" && kinds.has("amendment_approved:proponent")
        );
      case "amendment_reopened":
        return !kinds.has("position_changed");
      default:
        return true;
    }
  });
}

/** The news, latest first, in words (homeWorkNewsItem), without repeats. */
export function homeWorkNews(work: MeWorkDto): HomeWorkNews[] {
  return homeWorkNewsDeduped(work.news)
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
    news: work.news.filter(here),
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
