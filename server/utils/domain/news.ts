import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../../db";
import {
  amendmentAuthors,
  amendmentSources,
  amendments,
  documents,
  events,
  members,
} from "../../db/schema";
import type {
  AssemblySettings,
  AssemblyStatus,
} from "~~/shared/constants/domain";
import type { MeWorkAssemblyRef, MeWorkNewsDto } from "~~/shared/types/api";
import { toMemberRef } from "../members/dto";
import type { Actor } from "./actor";
import { canSeeLoadedAmendment, findAmendmentsByIds } from "./amendments";
import {
  impersonatedByFor,
  loadImpersonators,
  seesImpersonator,
} from "./impersonators";
import { coPresentedBy, withCoProponentIds } from "./presenters";
import {
  canSeeDocument,
  canSeePositions,
  isDocumentPresenter,
  redactMember,
} from "./visibility";

/**
 * "Novedades" on the home page (MeWorkDto.news): what others decided about
 * the work of the user's member in the last days (docs/api.md, "Home page").
 * - For a co-presenter: the main presenter's answers to the amendments of
 *   the document (position_changed).
 * - For the authors of an amendment: the main presenter's answer to it
 *   (position_changed), when the assembly's policy lets them see positions
 *   (canSeePositions).
 * - For the authors of an amendment: the main authors' answers to the
 *   transactionals over it, and to the transactionals the member proposed
 *   (acceptance_recorded).
 * - For the authors of an amendment: what the Secretaría, the Mesa or the
 *   assembly settled about it (NEWS_OUTCOME_TYPES). A transactional closed
 *   because a main author rejected it is said by that rejection
 *   (acceptance_recorded), so its withdrawal is left out.
 * - For the authors of an amendment a transactional groups (its parties
 *   among them): that transactional closing by itself, because what it
 *   groups was settled or replaced by another one (isAutomaticClosure).
 * - For the presenters of a document (main and co-presenters): what the
 *   Secretaría, the Mesa or the assembly settled about it
 *   (NEWS_DOCUMENT_TYPES), with no amendment.
 * Decisions the member took itself are left out, and so is anything the
 * actor cannot see. A transactional closing by itself is nobody's decision:
 * it names nobody (`by` null) and reaches its authors and parties also when
 * their own act on what it grouped closed it. What an Admin did while
 * acting as the user's account (events.impersonation_id) is not the user's
 * own decision either, so it reaches that account's news.
 */

/** How far back the news go. */
export const NEWS_WINDOW_DAYS = 30;
/** At most this many news, newest first. */
export const NEWS_LIMIT = 30;

/** Events about the member's own amendments that count as news. */
export const NEWS_OUTCOME_TYPES = [
  "amendment_validated",
  "amendment_published",
  "amendment_correction_requested",
  "amendment_reclassified",
  "amendment_authors_changed",
  "amendment_admitted",
  "amendment_inadmissible",
  "amendment_approved",
  "amendment_rejected",
  "amendment_withdrawn",
  "amendment_lapsed",
  "amendment_transacted",
  "amendment_reopened",
] as const;

/** Events about the member's own documents that count as news. */
export const NEWS_DOCUMENT_TYPES = [
  "document_published",
  "document_correction_requested",
  "document_voted",
  "document_status_changed",
] as const;

/** Events that may close a transactional by itself (isAutomaticClosure). */
const CLOSURE_TYPES = ["amendment_withdrawn", "amendment_lapsed"] as const;

const DAY = 24 * 60 * 60 * 1000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A transactional closed by itself, not by anyone's decision about it: an
 * amendment it groups was settled (amendment_withdrawn with
 * `by: "sources_closed"`), or another transactional replaced them first
 * (amendment_lapsed with `reason: "sources_transacted"`).
 */
export function isAutomaticClosure(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  return (
    (type === "amendment_withdrawn" && payload.by === "sources_closed") ||
    (type === "amendment_lapsed" && payload.reason === "sources_transacted")
  );
}

/** Why an event concerns the member (loadWorkNews). */
export interface NewsScope {
  /** A document the member presents (main presenter or co-presenter). */
  presented: boolean;
  /** An amendment to a document the member co-presents, not as main presenter. */
  coPresented: boolean;
  /** An amendment the member wrote (main author or co-author). */
  authored: boolean;
  /** A transactional over an amendment the member wrote. */
  overOwn: boolean;
}

/**
 * Whether an event is news for the member, by what it is about (`scope`).
 * Visibility and whether someone else decided it are checked apart
 * (loadWorkNews, isOthersDecision).
 */
export function isNewsEvent(
  event: {
    entityType: string;
    type: string;
    payload: Record<string, unknown>;
  },
  scope: NewsScope,
): boolean {
  const { type, payload } = event;
  if (event.entityType === "document") {
    return (
      scope.presented &&
      (NEWS_DOCUMENT_TYPES as readonly string[]).includes(type)
    );
  }
  if (event.entityType !== "amendment") return false;
  if (type === "position_changed") return scope.coPresented || scope.authored;
  if (type === "acceptance_recorded") return scope.authored || scope.overOwn;
  if (!(NEWS_OUTCOME_TYPES as readonly string[]).includes(type)) return false;
  // The rejection that closed it already says it.
  if (type === "amendment_withdrawn" && payload.by === "author_rejection") {
    return false;
  }
  return scope.authored || (scope.overOwn && isAutomaticClosure(type, payload));
}

/**
 * The decision in short (MeWorkNewsDto.value): the position, the answer to a
 * transactional, the admission a validation left, how an amendment was
 * approved, the code of the transactional that replaced it (or that
 * replaced first what a lapsed transactional grouped), the code of the
 * amendment whose fate closed a transactional, the result of a document's
 * final vote or the status a document moved to. Null when the type says it
 * all.
 */
export function newsValue(
  type: string,
  payload: Record<string, unknown>,
): string | null {
  switch (type) {
    case "position_changed":
      return text(payload.position);
    case "acceptance_recorded":
      return text(payload.decision);
    case "amendment_validated":
      return text(payload.admission);
    case "amendment_reclassified":
      return text(payload.to);
    case "amendment_authors_changed":
      return text(payload.code);
    case "amendment_approved":
      return text(payload.method);
    case "amendment_transacted":
      return text(payload.code);
    case "amendment_lapsed":
      return payload.reason === "sources_transacted"
        ? text(payload.code)
        : null;
    case "amendment_withdrawn":
      return payload.by === "sources_closed" ? text(payload.sourceCode) : null;
    case "document_voted":
      return text(payload.result);
    case "document_status_changed":
      return text(payload.to);
    default:
      return null;
  }
}

/**
 * Who decided (MeWorkNewsDto.by):
 * - nobody for a transactional that closed by itself (isAutomaticClosure):
 *   whoever settled what it grouped did not decide about it;
 * - the party that answered a transactional (payload.memberId);
 * - the main presenter for its answer to an amendment, for the amendment
 *   its acceptance incorporated (amendment_approved with method
 *   "proponent") and for one a new answer took out again
 *   (amendment_reopened with reason "position_changed"), also when the
 *   Mesa recorded it: payload.memberId, or the document's current main
 *   presenter (`mainPresenterId`) for events recorded before it was named;
 * - otherwise the member the actor acted for.
 */
export function newsByMemberId(
  type: string,
  payload: Record<string, unknown>,
  actorMemberId: string | null,
  mainPresenterId: string | null = null,
): string | null {
  if (isAutomaticClosure(type, payload)) return null;
  if (type === "acceptance_recorded") return text(payload.memberId);
  if (type === "position_changed") {
    const memberId = text(payload.memberId);
    if (memberId) return memberId;
    return payload.by === "moderator" ? mainPresenterId : actorMemberId;
  }
  if (type === "amendment_approved" && payload.method === "proponent") {
    return text(payload.memberId) ?? mainPresenterId;
  }
  if (type === "amendment_reopened" && payload.reason === "position_changed") {
    return mainPresenterId;
  }
  return actorMemberId;
}

/** An assembly the home page covers, with what news visibility needs. */
export interface NewsAssembly {
  ref: MeWorkAssemblyRef;
  settings: AssemblySettings;
  status: AssemblyStatus;
}

/**
 * Whether an event is someone else's decision: not taken by this user, nor
 * for this member (its other accounts, or the Mesa recording its answer as
 * main presenter or as a party). `mainPresenterId` is the main presenter of
 * the event's document (newsByMemberId). A transactional that closed by
 * itself (isAutomaticClosure) is nobody's decision, so it always counts,
 * also for the user whose act on what it grouped closed it. So does what an
 * Admin did while acting as this very account (`impersonationId` set): the
 * account did not decide it. Done as another account of the member, it
 * stays that member's own decision.
 */
export function isOthersDecision(
  event: {
    type: string;
    payload: Record<string, unknown>;
    actorUserId: string | null;
    actorMemberId: string | null;
    /** events.impersonation_id: an Admin did it while acting as actorUserId. */
    impersonationId?: string | null;
  },
  actor: { userId: string; memberId: string },
  mainPresenterId: string | null = null,
): boolean {
  if (isAutomaticClosure(event.type, event.payload)) return true;
  if (event.actorUserId === actor.userId) return Boolean(event.impersonationId);
  return (
    newsByMemberId(
      event.type,
      event.payload,
      event.actorMemberId,
      mainPresenterId,
    ) !== actor.memberId
  );
}

/**
 * The news of the actor's member over these assemblies (the ones the home
 * page covers), newest first.
 */
export async function loadWorkNews(
  actor: Actor,
  newsAssemblies: NewsAssembly[],
  now: Date,
): Promise<MeWorkNewsDto[]> {
  const memberId = actor.memberId;
  if (!memberId || newsAssemblies.length === 0) return [];
  const assemblyIds = newsAssemblies.map((assembly) => assembly.ref.id);
  const assemblyById = new Map(
    newsAssemblies.map((assembly) => [assembly.ref.id, assembly]),
  );
  const inAssemblies = inArray(documents.assemblyId, assemblyIds);

  const [presented, coPresented, authored, overOwn] = await Promise.all([
    // Documents the member presents, as main presenter or co-presenter.
    db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          inAssemblies,
          or(
            eq(documents.proponentMemberId, memberId),
            coPresentedBy(memberId),
          ),
        ),
      ),
    // Amendments to documents the member co-presents (not as main presenter).
    db
      .select({ id: amendments.id })
      .from(amendments)
      .innerJoin(documents, eq(documents.id, amendments.documentId))
      .where(
        and(
          inAssemblies,
          coPresentedBy(memberId),
          or(
            isNull(documents.proponentMemberId),
            ne(documents.proponentMemberId, memberId),
          ),
        ),
      ),
    // Amendments the member wrote (main author or co-author).
    db
      .select({ id: amendments.id })
      .from(amendmentAuthors)
      .innerJoin(amendments, eq(amendments.id, amendmentAuthors.amendmentId))
      .innerJoin(documents, eq(documents.id, amendments.documentId))
      .where(and(inAssemblies, eq(amendmentAuthors.memberId, memberId))),
    // Transactionals over amendments the member wrote.
    db
      .selectDistinct({ id: amendmentSources.transactionalId })
      .from(amendmentSources)
      .innerJoin(
        amendmentAuthors,
        eq(amendmentAuthors.amendmentId, amendmentSources.sourceId),
      )
      .innerJoin(amendments, eq(amendments.id, amendmentSources.sourceId))
      .innerJoin(documents, eq(documents.id, amendments.documentId))
      .where(and(inAssemblies, eq(amendmentAuthors.memberId, memberId))),
  ]);
  const presentedIds = new Set(presented.map((row) => row.id));
  const coPresentedIds = new Set(coPresented.map((row) => row.id));
  const authoredIds = new Set(authored.map((row) => row.id));
  const overOwnIds = new Set(overOwn.map((row) => row.id));

  // Broad scopes for the query; isNewsEvent decides on each row.
  const onAmendments = eq(events.entityType, "amendment");
  const scopes: SQL[] = [];
  const positionIds = [...new Set([...coPresentedIds, ...authoredIds])];
  if (positionIds.length > 0) {
    scopes.push(
      and(
        onAmendments,
        eq(events.type, "position_changed"),
        inArray(events.entityId, positionIds),
      )!,
    );
  }
  const acceptanceIds = [...new Set([...overOwnIds, ...authoredIds])];
  if (acceptanceIds.length > 0) {
    scopes.push(
      and(
        onAmendments,
        eq(events.type, "acceptance_recorded"),
        inArray(events.entityId, acceptanceIds),
      )!,
    );
  }
  if (authoredIds.size > 0) {
    scopes.push(
      and(
        onAmendments,
        inArray(events.type, [...NEWS_OUTCOME_TYPES]),
        inArray(events.entityId, [...authoredIds]),
      )!,
    );
  }
  if (overOwnIds.size > 0) {
    scopes.push(
      and(
        onAmendments,
        inArray(events.type, [...CLOSURE_TYPES]),
        inArray(events.entityId, [...overOwnIds]),
      )!,
    );
  }
  if (presentedIds.size > 0) {
    scopes.push(
      and(
        eq(events.entityType, "document"),
        inArray(events.type, [...NEWS_DOCUMENT_TYPES]),
        inArray(events.entityId, [...presentedIds]),
      )!,
    );
  }
  if (scopes.length === 0) return [];

  const rows = await db
    .select({
      id: events.id,
      assemblyId: events.assemblyId,
      entityType: events.entityType,
      entityId: events.entityId,
      type: events.type,
      payload: events.payload,
      actorUserId: events.actorUserId,
      actorMemberId: events.actorMemberId,
      impersonationId: events.impersonationId,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        inArray(events.assemblyId, assemblyIds),
        gte(events.createdAt, new Date(now.getTime() - NEWS_WINDOW_DAYS * DAY)),
        or(...scopes),
        // Not this user's own decisions (the rest is checked below), except
        // a transactional that closed by itself: its act on what that
        // transactional grouped closed it, but nobody decided it. Nor what
        // an Admin did while acting as this account: the user did not.
        or(
          isNull(events.actorUserId),
          ne(events.actorUserId, actor.user.id),
          isNotNull(events.impersonationId),
          and(
            eq(events.type, "amendment_withdrawn"),
            sql`${events.payload}->>'by' = 'sources_closed'`,
          ),
          and(
            eq(events.type, "amendment_lapsed"),
            sql`${events.payload}->>'reason' = 'sources_transacted'`,
          ),
        ),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    // Room for the ones the checks below leave out.
    .limit(NEWS_LIMIT * 3);
  const candidates = rows.filter((row) =>
    isNewsEvent(row, {
      presented: presentedIds.has(row.entityId),
      coPresented: coPresentedIds.has(row.entityId),
      authored: authoredIds.has(row.entityId),
      overOwn: overOwnIds.has(row.entityId),
    }),
  );
  if (candidates.length === 0) return [];

  const isDocumentNews = (row: { entityType: string }) =>
    row.entityType === "document";
  const amendmentRows = await findAmendmentsByIds([
    ...new Set(
      candidates
        .filter((row) => !isDocumentNews(row))
        .map((row) => row.entityId),
    ),
  ]);
  const amendmentById = new Map(amendmentRows.map((row) => [row.id, row]));
  const documentRows = await withCoProponentIds(
    await db
      .select({
        id: documents.id,
        slug: documents.slug,
        title: documents.title,
        status: documents.status,
        proponentMemberId: documents.proponentMemberId,
        submittedByUserId: documents.submittedByUserId,
      })
      .from(documents)
      .where(
        inArray(documents.id, [
          ...new Set([
            ...amendmentRows.map((row) => row.documentId),
            ...candidates.filter(isDocumentNews).map((row) => row.entityId),
          ]),
        ]),
      ),
  );
  const documentById = new Map(documentRows.map((row) => [row.id, row]));
  const documentOf = (row: { entityType: string; entityId: string }) => {
    if (isDocumentNews(row)) return documentById.get(row.entityId);
    const amendment = amendmentById.get(row.entityId);
    return amendment ? documentById.get(amendment.documentId) : undefined;
  };

  const visible = candidates
    .filter((row) => {
      const document = documentOf(row);
      if (document === undefined || !canSeeDocument(actor, document)) {
        return false;
      }
      // Credits the main presenter of the event's document (newsByMemberId).
      if (
        !isOthersDecision(
          row,
          { userId: actor.user.id, memberId },
          document.proponentMemberId,
        )
      ) {
        return false;
      }
      if (isDocumentNews(row)) return true;
      const amendment = amendmentById.get(row.entityId);
      const assembly = assemblyById.get(row.assemblyId);
      return (
        amendment !== undefined &&
        assembly !== undefined &&
        canSeeLoadedAmendment(actor, amendment) &&
        // The presenters always see the answers; the authors as the
        // assembly's policy says.
        (row.type !== "position_changed" ||
          canSeePositions(actor, {
            settings: assembly.settings,
            assemblyStatus: assembly.status,
            isPresenter: isDocumentPresenter(actor, document),
          }))
      );
    })
    .slice(0, NEWS_LIMIT);

  const byOf = (row: (typeof visible)[number]) =>
    newsByMemberId(
      row.type,
      row.payload,
      row.actorMemberId,
      documentOf(row)?.proponentMemberId ?? null,
    );
  const byIds = [
    ...new Set(visible.map(byOf).filter((id): id is string => id !== null)),
  ];
  const memberRows =
    byIds.length > 0
      ? await db
          .select({
            id: members.id,
            acronym: members.acronym,
            name: members.name,
            kind: members.kind,
          })
          .from(members)
          .where(inArray(members.id, byIds))
      : [];
  const memberById = new Map(memberRows.map((row) => [row.id, row]));
  // An Admin's act as this very account names the Admin. News are the
  // account's own page, so only its own acts say it ("actuando como tú");
  // Admins read the rest in the activity log.
  const self = { user: actor.user, isAdmin: false };
  const impersonators = await loadImpersonators(
    visible
      .filter((row) => seesImpersonator(self, row.actorUserId))
      .map((row) => row.impersonationId),
  );

  return visible.map((row) => {
    const amendment = isDocumentNews(row)
      ? null
      : amendmentById.get(row.entityId)!;
    const document = documentOf(row)!;
    const by = byOf(row);
    const member = by ? memberById.get(by) : undefined;
    return {
      id: row.id,
      assembly: assemblyById.get(row.assemblyId)!.ref,
      document: { id: document.id, slug: document.slug, title: document.title },
      amendment: amendment
        ? { id: amendment.id, code: amendment.code, kind: amendment.kind }
        : null,
      ownAmendment: amendment !== null && authoredIds.has(amendment.id),
      type: row.type,
      // An executive area reads as "CEA" to whoever may not see the areas.
      by: member ? redactMember(actor, toMemberRef(member)) : null,
      impersonatedBy: impersonatedByFor(self, row, impersonators),
      value: newsValue(row.type, row.payload),
      at: row.createdAt.toISOString(),
    };
  });
}
