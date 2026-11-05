import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  or,
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
import { coPresentedBy, withCoProponentIds } from "./presenters";
import {
  canSeeDocument,
  canSeePositions,
  isDocumentPresenter,
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
 *   assembly settled about it (NEWS_OUTCOME_TYPES).
 * - For the presenters of a document (main and co-presenters): what the
 *   Secretaría, the Mesa or the assembly settled about it
 *   (NEWS_DOCUMENT_TYPES), with no amendment.
 * Decisions the member took itself are left out, and so is anything the
 * actor cannot see.
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

const DAY = 24 * 60 * 60 * 1000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The decision in short (MeWorkNewsDto.value): the position, the answer to a
 * transactional, the admission a validation left, how an amendment was
 * approved, the result of a document's final vote or the status a document
 * moved to. Null when the type says it all.
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
    case "amendment_approved":
      return text(payload.method);
    case "document_voted":
      return text(payload.result);
    case "document_status_changed":
      return text(payload.to);
    default:
      return null;
  }
}

/**
 * Who decided (MeWorkNewsDto.by): the party that answered a transactional,
 * or the main presenter that answered an amendment, also when the Mesa
 * recorded the answer for them (payload.memberId); otherwise the member the
 * actor acted for. An answer the Mesa recorded before positions named the
 * main presenter has nobody to credit (null): not the Mesa member's own.
 */
export function newsByMemberId(
  type: string,
  payload: Record<string, unknown>,
  actorMemberId: string | null,
): string | null {
  if (type === "acceptance_recorded") return text(payload.memberId);
  if (type === "position_changed") {
    const memberId = text(payload.memberId);
    if (memberId) return memberId;
    return payload.by === "moderator" ? null : actorMemberId;
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
 * for this member (its other accounts, or the Mesa recording its answer).
 */
export function isOthersDecision(
  event: {
    type: string;
    payload: Record<string, unknown>;
    actorUserId: string | null;
    actorMemberId: string | null;
  },
  actor: { userId: string; memberId: string },
): boolean {
  if (event.actorUserId === actor.userId) return false;
  return (
    newsByMemberId(event.type, event.payload, event.actorMemberId) !==
    actor.memberId
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
  const presentedIds = presented.map((row) => row.id);
  const coPresentedIds = coPresented.map((row) => row.id);
  const authoredIds = authored.map((row) => row.id);
  const acceptanceIds = [
    ...new Set([...overOwn.map((row) => row.id), ...authoredIds]),
  ];

  const positionIds = [...new Set([...coPresentedIds, ...authoredIds])];

  const onAmendments = eq(events.entityType, "amendment");
  const scopes: SQL[] = [];
  if (positionIds.length > 0) {
    scopes.push(
      and(
        onAmendments,
        eq(events.type, "position_changed"),
        inArray(events.entityId, positionIds),
      )!,
    );
  }
  if (acceptanceIds.length > 0) {
    scopes.push(
      and(
        onAmendments,
        eq(events.type, "acceptance_recorded"),
        inArray(events.entityId, acceptanceIds),
      )!,
    );
  }
  if (authoredIds.length > 0) {
    scopes.push(
      and(
        onAmendments,
        inArray(events.type, [...NEWS_OUTCOME_TYPES]),
        inArray(events.entityId, authoredIds),
      )!,
    );
  }
  if (presentedIds.length > 0) {
    scopes.push(
      and(
        eq(events.entityType, "document"),
        inArray(events.type, [...NEWS_DOCUMENT_TYPES]),
        inArray(events.entityId, presentedIds),
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
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        inArray(events.assemblyId, assemblyIds),
        gte(events.createdAt, new Date(now.getTime() - NEWS_WINDOW_DAYS * DAY)),
        or(...scopes),
        // Not this user's own decisions (the rest is checked below).
        or(isNull(events.actorUserId), ne(events.actorUserId, actor.user.id)),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    // Room for the ones the checks below leave out.
    .limit(NEWS_LIMIT * 3);
  const candidates = rows.filter((row) =>
    isOthersDecision(row, { userId: actor.user.id, memberId }),
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

  const visible = candidates
    .filter((row) => {
      if (isDocumentNews(row)) {
        const document = documentById.get(row.entityId);
        return document !== undefined && canSeeDocument(actor, document);
      }
      const amendment = amendmentById.get(row.entityId);
      const document = amendment && documentById.get(amendment.documentId);
      const assembly = assemblyById.get(row.assemblyId);
      return (
        amendment !== undefined &&
        document !== undefined &&
        assembly !== undefined &&
        canSeeDocument(actor, document) &&
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

  const byIds = [
    ...new Set(
      visible
        .map((row) => newsByMemberId(row.type, row.payload, row.actorMemberId))
        .filter((id): id is string => id !== null),
    ),
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

  return visible.map((row) => {
    const amendment = isDocumentNews(row)
      ? null
      : amendmentById.get(row.entityId)!;
    const document = documentById.get(
      amendment ? amendment.documentId : row.entityId,
    )!;
    const by = newsByMemberId(row.type, row.payload, row.actorMemberId);
    const member = by ? memberById.get(by) : undefined;
    return {
      id: row.id,
      assembly: assemblyById.get(row.assemblyId)!.ref,
      document: { id: document.id, slug: document.slug, title: document.title },
      amendment: amendment ? { id: amendment.id, code: amendment.code } : null,
      type: row.type,
      by: member ? toMemberRef(member) : null,
      value: newsValue(row.type, row.payload),
      at: row.createdAt.toISOString(),
    };
  });
}
