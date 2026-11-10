import {
  GENERIC_EXECUTIVE_MEMBER,
  GENERIC_EXECUTIVE_MEMBER_ID,
  type AmendmentStatus,
  type AssemblySettings,
  type AssemblyStatus,
  type DecisionKind,
  type DocumentStatus,
} from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type {
  AcceptanceDto,
  DecisionDto,
  MemberRef,
} from "~~/shared/types/api";
import {
  actsFor,
  canManageAssemblies,
  canManageDocuments,
  canModerate,
  canReviewAmendments,
  type Actor,
} from "./actor";

/** Draft assemblies are only visible to those who manage assemblies. */
export function canSeeAssembly(
  actor: Actor,
  assembly: { status: AssemblyStatus },
): boolean {
  return (
    assembly.status !== "draft" ||
    canManageAssemblies(actor) ||
    canModerate(actor)
  );
}

/**
 * Who presents a document: its main presenter (`documents.proponentMemberId`),
 * who answers the amendments, and its co-presenters (document_proponents),
 * who prepare the text with it and follow what it decides.
 */
export interface DocumentPresenters {
  proponentMemberId: string | null;
  /** Co-presenters, never the main presenter. Always loaded: see presenters.ts. */
  coProponentMemberIds: readonly string[];
}

/** The actor acts for the main presenter or for a co-presenter. */
export function isDocumentPresenter(
  actor: Actor,
  document: DocumentPresenters,
): boolean {
  return actsFor(actor, [
    document.proponentMemberId,
    ...document.coProponentMemberIds,
  ]);
}

/**
 * Published documents are public. Submissions under review and withdrawn
 * documents are visible to their presenters (main or co-presenters), the
 * user who submitted them, managers and the Mesa. Drafts are private: only
 * their presenters, the user who created them and managers
 * (document:manage) see them.
 */
export function canSeeDocument(
  actor: Actor,
  document: DocumentPresenters & {
    status: DocumentStatus;
    submittedByUserId: string | null;
  },
): boolean {
  if (document.status === "published" || document.status === "postponed")
    return true;
  if (canManageDocuments(actor)) return true;
  if (document.status !== "draft" && canModerate(actor)) return true;
  if (document.submittedByUserId === actor.user.id) return true;
  return isDocumentPresenter(actor, document);
}

/**
 * The actor acts for the main presenter, the only one who answers the
 * amendments to the document (its position) and appears as its proponent.
 */
export function isDocumentProponent(
  actor: Actor,
  document: { proponentMemberId: string | null },
): boolean {
  return actsFor(actor, [document.proponentMemberId]);
}

export interface AmendmentVisibilityContext {
  status: AmendmentStatus;
  /** Set by the Secretaría: the amendment is visible to everyone. */
  publishedAt: Date | null;
  createdByUserId: string | null;
  authorMemberIds: string[];
  /**
   * For transactionals: its parties (the main authors of the amendments it
   * would replace) and the other authors of those amendments.
   */
  partyMemberIds: string[];
}

/**
 * Whether the actor sees every presented (non-draft) amendment, published or
 * not: the Secretaría (amendment:review or amendment:manage) and the Mesa.
 * Callers use it to skip the per-amendment rule of `canSeeAmendment`.
 */
export function seesAllPresentedAmendments(actor: Actor): boolean {
  return canReviewAmendments(actor) || canModerate(actor);
}

/** The actor wrote the amendment, created it or is a party of the transactional. */
export function isAmendmentInsider(
  actor: Actor,
  amendment: Pick<
    AmendmentVisibilityContext,
    "createdByUserId" | "authorMemberIds" | "partyMemberIds"
  >,
): boolean {
  return (
    amendment.createdByUserId === actor.user.id ||
    actsFor(actor, amendment.authorMemberIds) ||
    actsFor(actor, amendment.partyMemberIds)
  );
}

/**
 * Who sees an amendment of a document the actor can see. Visibility is per
 * amendment: the Secretaría publishes each one, when validating it or later.
 * - Drafts: their authors, the user who created them, the parties of a
 *   transactional and reviewers (amendment:review or amendment:manage). The
 *   Mesa alone does not read members' private drafts; the drafts it creates
 *   itself are covered by `createdByUserId`.
 * - Presented and published (`publishedAt`): everyone.
 * - Presented, not published yet (waiting for validation, validated but kept
 *   private, or decided before publication): its authors, its creator, the
 *   parties of a transactional, reviewers and the Mesa.
 */
export function canSeeAmendment(
  actor: Actor,
  amendment: AmendmentVisibilityContext,
): boolean {
  const insider = isAmendmentInsider(actor, amendment);
  if (amendment.status === "draft") {
    return insider || canReviewAmendments(actor);
  }
  if (amendment.publishedAt) return true;
  return insider || seesAllPresentedAmendments(actor);
}

/** Event types whose payload carries a correction note (`note`). */
const CORRECTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "document_correction_requested",
  "amendment_correction_requested",
]);

/**
 * Correction notes are meant for the presenters and the Secretaría or Mesa
 * only (correctionNote in the DTOs). The history keeps them in the payload,
 * so they are removed for everyone else, even after publication.
 */
export function redactCorrectionNote(
  type: string,
  payload: Record<string, unknown>,
  noteVisible: boolean,
): Record<string, unknown> {
  if (noteVisible || !CORRECTION_EVENT_TYPES.has(type) || !("note" in payload))
    return payload;
  const rest = { ...payload };
  delete rest.note;
  return rest;
}

/** Event types whose payload carries a document's field values (`changes`). */
const DOCUMENT_CHANGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "document_updated",
]);

/**
 * `document_updated.changes` holds what the title, summary, presenters and
 * other fields were and became, also while the document was a draft only
 * its presenters and the Secretaría could read. Like correction notes, it
 * is removed for everyone else (`visible`: canSeeDocumentCorrection), even
 * after publication; `fields` still says which fields changed.
 */
export function redactDocumentChanges(
  type: string,
  payload: Record<string, unknown>,
  visible: boolean,
): Record<string, unknown> {
  if (
    visible ||
    !DOCUMENT_CHANGE_EVENT_TYPES.has(type) ||
    !("changes" in payload)
  )
    return payload;
  const rest = { ...payload };
  delete rest.changes;
  return rest;
}

/** Decision kinds whose `subjectIds` are amendment ids. */
const AMENDMENT_DECISION_KINDS: ReadonlySet<DecisionKind> = new Set([
  "admit_late",
  "inadmission",
]);

/** Amendment ids named by admission decisions (`admit_late`, `inadmission`). */
export function decisionAmendmentIds(decisions: DecisionDto[]): string[] {
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (!AMENDMENT_DECISION_KINDS.has(decision.kind)) continue;
    for (const id of decision.subjectIds) ids.add(id);
  }
  return [...ids];
}

/**
 * Decisions as the actor may read them. An admission decision keeps only the
 * amendments the actor can see in `subjectIds` and is dropped when it names
 * none of them, so its note and vote do not reveal amendments that are still
 * private (not published). A decision that keeps at least one subject keeps
 * its note: it is the reason its visible amendment was admitted or refused.
 * Other kinds are returned unchanged.
 */
export function filterDecisionsByAmendment(
  decisions: DecisionDto[],
  isVisible: (amendmentId: string) => boolean,
): DecisionDto[] {
  const result: DecisionDto[] = [];
  for (const decision of decisions) {
    if (!AMENDMENT_DECISION_KINDS.has(decision.kind)) {
      result.push(decision);
      continue;
    }
    const subjectIds = decision.subjectIds.filter(isVisible);
    if (subjectIds.length === 0) continue;
    result.push(
      subjectIds.length === decision.subjectIds.length
        ? decision
        : { ...decision, subjectIds },
    );
  }
  return result;
}

/**
 * Who sees the main presenter's position on amendments: its presenters
 * (main and co-presenters, who follow what the main one decides), the Mesa
 * and the Secretaría always; everyone else per the assembly's policy.
 */
export function canSeePositions(
  actor: Actor,
  options: {
    settings: AssemblySettings;
    assemblyStatus: AssemblyStatus;
    isPresenter: boolean;
  },
): boolean {
  if (options.isPresenter || canModerate(actor) || canReviewAmendments(actor))
    return true;
  if (options.settings.positionVisibility === "public") return true;
  return (
    options.settings.positionVisibility === "session" &&
    (options.assemblyStatus === "in_session" ||
      options.assemblyStatus === "closed")
  );
}

// Executive areas ------------------------------------------------------------

/** Roles that see the real executive area behind a document or amendment. */
const EXECUTIVE_VISIBLE_ROLES: ReadonlySet<string> = new Set([
  SYSTEM_ROLES.ADMIN,
  SYSTEM_ROLES.SECRETARIA,
  SYSTEM_ROLES.PRESIDENCIA,
  SYSTEM_ROLES.MODERADOR,
  SYSTEM_ROLES.CEA,
]);

/** Management permissions that imply it, whatever the role. */
const EXECUTIVE_VISIBLE_PERMISSIONS = [
  PERMISSION_KEYS.DOCUMENT_MANAGE,
  PERMISSION_KEYS.AMENDMENT_REVIEW,
  PERMISSION_KEYS.AMENDMENT_MANAGE,
  PERMISSION_KEYS.ASSEMBLY_MANAGE,
  PERMISSION_KEYS.SESSION_MODERATE,
  PERMISSION_KEYS.MEMBER_MANAGE,
  PERMISSION_KEYS.USER_MANAGE_ROLES,
] as const;

/**
 * Whether the actor sees the executive areas (members of kind "executive")
 * as they are: the CEA itself, the Secretaría, the Presidencia, the Mesa and
 * anyone who manages documents, amendments, assemblies, members or users, or
 * who acts for an area. Everyone else (Asociado, Sectorial, Invitado) gets
 * one generic presenter, "CEA", wherever an area would appear: the server
 * replaces it in every answer, so nothing on screen has to hide it.
 */
export function canSeeExecutiveMembers(actor: Actor): boolean {
  if (actor.isAdmin) return true;
  const role = actor.user.role?.name;
  if (role && EXECUTIVE_VISIBLE_ROLES.has(role)) return true;
  if (EXECUTIVE_VISIBLE_PERMISSIONS.some((key) => actor.can(key))) return true;
  return actor.memberKind === "executive";
}

/**
 * Whether the actor may read the real executive areas to name them as
 * authors of an amendment or a transactional it composes (GET
 * /api/members?for=amendment): whoever sees them anyway, and an account
 * that presents amendments for a member. Only that list: everything it
 * reads afterwards, its own draft included, shows the generic "CEA".
 */
export function canNameExecutiveAuthors(actor: Actor): boolean {
  return (
    canSeeExecutiveMembers(actor) ||
    (actor.can(PERMISSION_KEYS.AMENDMENT_CREATE) && actor.memberId !== null)
  );
}

/** The generic presenter shown instead of an executive area. */
export function genericExecutiveMember(): MemberRef {
  return { ...GENERIC_EXECUTIVE_MEMBER };
}

/**
 * A member as the actor may read it: an executive area becomes the generic
 * presenter for an actor who does not see the areas. The actor's own member
 * is never replaced (acting for an area is seeing them).
 */
export function redactMember(actor: Actor, member: MemberRef): MemberRef {
  if (member.kind !== "executive" || canSeeExecutiveMembers(actor))
    return member;
  return genericExecutiveMember();
}

/**
 * The acronym the actor reads for a member: "CEA" for an area it may not
 * see. For the answers that name members by acronym only, such as the PDFs.
 */
export function visibleAcronym(
  actor: Actor,
  member: Pick<MemberRef, "acronym" | "kind">,
): string {
  return member.kind === "executive" && !canSeeExecutiveMembers(actor)
    ? GENERIC_EXECUTIVE_MEMBER.acronym
    : member.acronym;
}

export function redactMemberOrNull(
  actor: Actor,
  member: MemberRef | null | undefined,
): MemberRef | null {
  return member ? redactMember(actor, member) : null;
}

/**
 * A list as the actor may read it: every entry of an executive area
 * collapses into one, built by `generic` from all of them and placed where
 * the first of them was. Unchanged for an actor who sees the areas.
 */
export function collapseExecutive<T extends { kind: MemberRef["kind"] }>(
  actor: Actor,
  items: T[],
  generic: (areas: T[]) => T,
): T[] {
  if (canSeeExecutiveMembers(actor)) return items;
  const areas = items.filter((item) => item.kind === "executive");
  if (areas.length === 0) return items;
  const result: T[] = [];
  let collapsed = false;
  for (const item of items) {
    if (item.kind !== "executive") {
      result.push(item);
    } else if (!collapsed) {
      collapsed = true;
      result.push(generic(areas));
    }
  }
  return result;
}

/**
 * A list in acronym order with the generic entry moved to where "CEA" sorts
 * among the others, which keep their order. Where the first area sat would
 * narrow down which area it is.
 */
export function placeGenericByAcronym<
  T extends { id: string; acronym: string },
>(items: T[]): T[] {
  const generic = items.find((item) => item.id === GENERIC_EXECUTIVE_MEMBER_ID);
  if (!generic) return items;
  const others = items.filter(
    (item) => item.id !== GENERIC_EXECUTIVE_MEMBER_ID,
  );
  const at = others.findIndex(
    (item) => item.acronym.localeCompare(generic.acronym) > 0,
  );
  const index = at === -1 ? others.length : at;
  return [...others.slice(0, index), generic, ...others.slice(index)];
}

/**
 * A list of members as the actor may read it: every executive area collapses
 * into one generic entry, placed where the first of them was. A caller whose
 * list is in acronym order moves it with placeGenericByAcronym.
 */
export function redactMembers(actor: Actor, members: MemberRef[]): MemberRef[] {
  return collapseExecutive(actor, members, genericExecutiveMember);
}

/**
 * The presenters of a document as the actor may read them. With an area as
 * main presenter the generic entry is not repeated among the co-presenters,
 * where it otherwise sits in acronym order like the rest.
 */
export function redactPresenters(
  actor: Actor,
  proponent: MemberRef | null,
  coProponents: MemberRef[],
): { proponent: MemberRef | null; coProponents: MemberRef[] } {
  if (canSeeExecutiveMembers(actor)) return { proponent, coProponents };
  const main = redactMemberOrNull(actor, proponent);
  // Co-presenters come in acronym order: "CEA" goes where it sorts.
  const co = placeGenericByAcronym(redactMembers(actor, coProponents));
  return {
    proponent: main,
    coProponents:
      main?.id === GENERIC_EXECUTIVE_MEMBER_ID
        ? co.filter((member) => member.id !== GENERIC_EXECUTIVE_MEMBER_ID)
        : co,
  };
}

/**
 * The authors of an amendment and its main author as the actor may read
 * them: `mainAuthorId` follows its author into the generic entry.
 */
export function redactAuthors(
  actor: Actor,
  authors: MemberRef[],
  mainAuthorId: string | null,
): { authors: MemberRef[]; mainAuthorId: string | null } {
  if (canSeeExecutiveMembers(actor)) return { authors, mainAuthorId };
  const main = authors.find((author) => author.id === mainAuthorId);
  return {
    authors: redactMembers(actor, authors),
    mainAuthorId:
      main?.kind === "executive" ? GENERIC_EXECUTIVE_MEMBER_ID : mainAuthorId,
  };
}

/**
 * The parties of a transactional as the actor may read them: the areas
 * answer as one "CEA". Together they rejected it if any did, are still
 * pending while any is, and accepted it once all did (as authorsApproval
 * reads the whole list), at the time of the last answer.
 */
export function redactAcceptances(
  actor: Actor,
  acceptances: AcceptanceDto[],
): AcceptanceDto[] {
  if (canSeeExecutiveMembers(actor)) return acceptances;
  const areas = acceptances.filter(
    (acceptance) => acceptance.member.kind === "executive",
  );
  if (areas.length === 0) return acceptances;
  const decision = areas.some((area) => area.decision === "rejected")
    ? "rejected"
    : areas.some((area) => area.decision === "pending")
      ? "pending"
      : "accepted";
  const answered = areas
    .map((area) => area.decidedAt)
    .filter((at): at is string => at !== null)
    .sort();
  const merged: AcceptanceDto = {
    member: genericExecutiveMember(),
    role: areas[0]!.role,
    decision,
    decidedAt:
      decision === "pending" ? null : (answered[answered.length - 1] ?? null),
    recordedBy: areas.some((area) => area.recordedBy === "mesa")
      ? "mesa"
      : "party",
  };
  const result: AcceptanceDto[] = [];
  let placed = false;
  for (const acceptance of acceptances) {
    if (acceptance.member.kind !== "executive") result.push(acceptance);
    else if (!placed) {
      placed = true;
      result.push(merged);
    }
  }
  return result;
}

/**
 * What an actor who does not see the areas must not learn: the ids of every
 * executive member. Null for an actor who sees them (nothing is hidden).
 * Loaded with `loadExecutiveMask` (executiveMembers.ts) where an answer
 * carries bare member ids, such as event payloads.
 */
export type ExecutiveMask = ReadonlySet<string> | null;

/** A member id as the masked actor may read it. */
export function redactMemberId<T extends string | null | undefined>(
  mask: ExecutiveMask,
  id: T,
): T | typeof GENERIC_EXECUTIVE_MEMBER_ID {
  return mask && id && mask.has(id) ? GENERIC_EXECUTIVE_MEMBER_ID : id;
}

function maskValue(mask: ReadonlySet<string>, value: unknown): unknown {
  if (typeof value === "string") {
    return mask.has(value) ? GENERIC_EXECUTIVE_MEMBER_ID : value;
  }
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => maskValue(mask, entry));
    if (!mapped.includes(GENERIC_EXECUTIVE_MEMBER_ID)) return mapped;
    // Several areas in a list of ids read as one generic entry, always the
    // last one: id lists are stored sorted, and the place of an area among
    // the real ids around it would narrow down which area it is.
    return [
      ...mapped.filter((entry) => entry !== GENERIC_EXECUTIVE_MEMBER_ID),
      GENERIC_EXECUTIVE_MEMBER_ID,
    ];
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        maskValue(mask, entry),
      ]),
    );
  }
  return value;
}

/**
 * An event or audit payload as the masked actor may read it: every member
 * id of an executive area, at any depth and under any key (authorMemberIds,
 * mainAuthorId, onBehalfOfMemberId, changes...), becomes the generic id.
 * Payloads carry ids only, never names, so this is all they need.
 */
export function redactPayloadMembers<T extends Record<string, unknown>>(
  mask: ExecutiveMask,
  payload: T,
): T {
  if (!mask || mask.size === 0) return payload;
  return maskValue(mask, payload) as T;
}

/**
 * Who did something, as the actor may read it: when the member acted for is
 * an executive area the actor does not see, the member becomes the generic
 * presenter and the person's name goes too, since it would name the area.
 */
export function redactEventActor<T extends string | null>(
  actor: Actor,
  who: { actorName: T; actorMember: MemberRef | null },
): { actorName: T | null; actorMember: MemberRef | null } {
  if (who.actorMember?.kind !== "executive" || canSeeExecutiveMembers(actor)) {
    return who;
  }
  return { actorName: null, actorMember: genericExecutiveMember() };
}
