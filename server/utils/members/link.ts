import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { members, users } from "../../db/schema";
import { AUDIT_ACTIONS } from "../../../shared/constants/activity";
import type {
  MemberKind,
  MemberSource,
} from "../../../shared/constants/domain";
import { logInfo, logWarn } from "../core/logger";
import { recordAudit } from "../domain/audit";
import { memberAuditState } from "./sync";

/** Member kinds an intranet account can act for. */
export type LinkedMemberKind = Extract<
  MemberKind,
  "asociado" | "sectorial" | "executive" | "other"
>;

/**
 * Intranet account types (intranet `users.type`) linked to a member, each
 * by its intranet id first, then its email, then its initials (only to a
 * member stored before the Intranet sent either): Asociado and Sectorial
 * accounts are the member itself, a CEA account is the place of its
 * executive office, which outlives whoever holds it (the CEA list,
 * `/usuarios/cea`, sends the same id), and the Coordinación del CAS (the
 * role lookup answers "CAS" for it) is the member "CAS", of kind "other"
 * (the CAS list, `/usuarios/cas`, sends the same id).
 */
export const INTRANET_MEMBER_TYPES: ReadonlyMap<string, LinkedMemberKind> =
  new Map<string, LinkedMemberKind>([
    ["Asociado", "asociado"],
    ["Sectorial", "sectorial"],
    ["CEA", "executive"],
    ["CAS", "other"],
  ]);

export interface ExternalMemberIdentity {
  /**
   * The intranet `users.id` of the account; null or absent when the
   * intranet sends none.
   */
  id?: number | null;
  /** Intranet `type`, e.g. "Asociado". */
  role: string;
  initials: string | null;
  name: string | null;
  university: string | null;
  /** Its university's acronym (UGR, UVa); absent from older answers. */
  university_acronym?: string | null;
}

const ACRONYM_MAX_LENGTH = 20;
const NAME_MAX_LENGTH = 200;

/** The acronym an account's initials stand for, or null when there are none. */
export function initialsToAcronym(initials: string | null): string | null {
  const acronym = initials
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, ACRONYM_MAX_LENGTH);
  return acronym || null;
}

/**
 * Whether an account that acts for a member of `kind` may be linked to the
 * existing member with its acronym. A CEA account only links to an executive
 * area (or an "other" member), and the CAS only to an "other" member, never
 * to a council or a sectorial that happens to share its initials.
 */
export function canLinkToMember(
  kind: LinkedMemberKind,
  existingKind: MemberKind,
): boolean {
  if (kind === "other") return existingKind === "other";
  if (kind !== "executive") return true;
  return existingKind === "executive" || existingKind === "other";
}

/**
 * The intranet id an account is linked to its member by: the account's own
 * id, for every kind (a CEA account is its office's place).
 */
export function memberIntranetId(
  _kind: LinkedMemberKind,
  id: number | null | undefined,
): number | null {
  return typeof id === "number" ? id : null;
}

/**
 * The member created when none has the intranet id, the email or the acronym
 * yet: an intranet member with the account's intranet id and email (the
 * address it signed in with, the one the Intranet looked up), which the
 * roster matches first and whose next sync fills in its details (or
 * deactivates it, once
 * the Intranet no longer lists it). An executive office and the CAS are
 * named after their acronym until then, since those accounts carry the name
 * of the person who holds the place, not the office's or the committee's.
 */
export function newLinkedMember(
  kind: LinkedMemberKind,
  acronym: string,
  external: Pick<
    ExternalMemberIdentity,
    "id" | "name" | "university" | "university_acronym"
  >,
  now = new Date(),
  email: string | null = null,
): {
  kind: LinkedMemberKind;
  acronym: string;
  name: string;
  university: string | null;
  universityAcronym: string | null;
  intranetId: number | null;
  email: string | null;
  source: MemberSource;
  active: boolean;
  syncedAt: Date | null;
} {
  const namedAfterAcronym = kind === "executive" || kind === "other";
  const university =
    kind === "asociado"
      ? external.university?.trim().slice(0, NAME_MAX_LENGTH) || null
      : null;
  return {
    kind,
    acronym,
    name: namedAfterAcronym
      ? acronym
      : external.name?.trim().slice(0, NAME_MAX_LENGTH) || acronym,
    university,
    universityAcronym: university
      ? external.university_acronym?.trim() || null
      : null,
    intranetId: memberIntranetId(kind, external.id),
    email,
    source: "intranet",
    active: true,
    syncedAt: now,
  };
}

/**
 * Whether a member found by acronym belongs to another intranet account:
 * both ids, or both emails, are known and differ (the acronym moved to
 * another council). Linking by acronym is then refused.
 */
export function acronymHeldByAnotherAccount(
  accountIntranetId: number | null,
  memberIntranetId: number | null,
  accountEmail: string | null = null,
  memberEmail: string | null = null,
): boolean {
  const differ = <T>(a: T | null, b: T | null) =>
    a !== null && b !== null && a !== b;
  return (
    differ(accountIntranetId, memberIntranetId) ||
    differ(accountEmail, memberEmail)
  );
}

/** An email compared the way the roster stores it: trimmed, lowercased. */
export function normalizeEmail(email: string | null | undefined) {
  const value = email?.trim().toLowerCase();
  return value || null;
}

/** Initials compared the way acronyms are matched: normalized, any case. */
function sameInitials(a: string | null, b: string | null): boolean {
  return (
    initialsToAcronym(a)?.toLowerCase() === initialsToAcronym(b)?.toLowerCase()
  );
}

/**
 * Whether role sync leaves the account's current member alone. A CEA account
 * that already acts for a member keeps it while its intranet initials stay
 * the same: an admin may have linked it by hand
 * (PUT /api/admin/users/[id]/member), for example because the intranet
 * initials are the person's rather than the area's. When the initials
 * change (the cargo moved to another area) it is linked again by them.
 * Councils and sectorials always follow their initials: the account is the
 * member itself.
 */
export function keepsCurrentLink(input: {
  kind: LinkedMemberKind;
  currentMemberId: string | null;
  previousInitials: string | null;
  initials: string | null;
}): boolean {
  return (
    input.kind === "executive" &&
    input.currentMemberId !== null &&
    sameInitials(input.previousInitials, input.initials)
  );
}

interface FoundMember {
  id: string;
  kind: MemberKind;
  intranetId: number | null;
  email: string | null;
}

const foundMemberColumns = {
  id: members.id,
  kind: members.kind,
  intranetId: members.intranetId,
  email: members.email,
};

function findMemberByAcronym(acronym: string): Promise<FoundMember | null> {
  return db
    .select(foundMemberColumns)
    .from(members)
    .where(sql`lower(${members.acronym}) = lower(${acronym})`)
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/** The member of that kind with the intranet id, if any. */
function findMemberByIntranetId(
  intranetId: number,
  kind: LinkedMemberKind,
): Promise<FoundMember | null> {
  return db
    .select(foundMemberColumns)
    .from(members)
    .where(and(eq(members.intranetId, intranetId), eq(members.kind, kind)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/** The member of that kind with the email, if any. */
function findMemberByEmail(
  email: string,
  kind: LinkedMemberKind,
): Promise<FoundMember | null> {
  return db
    .select(foundMemberColumns)
    .from(members)
    .where(and(eq(members.email, email), eq(members.kind, kind)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * By intranet id first (when there is one), then by email (the account was
 * recreated in the Intranet with the same address), then by acronym.
 */
async function findLinkedMember(
  kind: LinkedMemberKind,
  intranetId: number | null,
  email: string | null,
  acronym: string | null,
): Promise<FoundMember | null> {
  if (intranetId !== null) {
    const byId = await findMemberByIntranetId(intranetId, kind);
    if (byId) return byId;
  }
  if (email !== null) {
    const byEmail = await findMemberByEmail(email, kind);
    if (byEmail) return byEmail;
  }
  return acronym ? findMemberByAcronym(acronym) : null;
}

/**
 * Links `users.memberId` after a successful role sync, when the intranet
 * account is an Asociado, a Sectorial or a CEA account: to the member of
 * its kind with its intranet `id` first (it survives a change of acronym),
 * then to the one with the account's email (it survives the account being
 * recreated), then to the member with its `initials` (the acronym), unless
 * that member belongs to another intranet account, by id or by email
 * (acronymHeldByAnotherAccount). The
 * member is created when none matches yet (see newLinkedMember). A CEA account that already acts for a member keeps it
 * until its initials change (keepsCurrentLink); `previousInitials` are the
 * ones stored by the previous sync.
 *
 * Other external roles leave `memberId` alone: it may have been set by hand
 * (PUT /api/admin/users/[id]/member), for example for an account without
 * initials. Role sync clears it when the account stops acting for its
 * member (stopsActingForMember in roleSync.ts).
 *
 * Traceability (source `intranet`, no actor): a member created here writes
 * `member.create` (after.reason "sign_in_link"), and a link that really
 * changes writes `user.member_link` (after.reason "role_sync"), each in the
 * transaction of its write.
 *
 * Returns the linked member id, or null when nothing was linked.
 */
export async function linkUserToIntranetMember(
  userId: string,
  external: ExternalMemberIdentity,
  options: { previousInitials?: string | null } = {},
): Promise<string | null> {
  const kind = INTRANET_MEMBER_TYPES.get(external.role);
  if (!kind) return null;
  const acronym = initialsToAcronym(external.initials);
  const intranetId = memberIntranetId(kind, external.id);
  if (!acronym && intranetId === null) return null;

  const [account] = await db
    .select({ memberId: users.memberId, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!account) return null;
  // The address the Intranet looked the account up by.
  const email = normalizeEmail(account.email);
  if (
    keepsCurrentLink({
      kind,
      currentMemberId: account.memberId,
      previousInitials: options.previousInitials ?? null,
      initials: external.initials,
    })
  ) {
    return null;
  }

  let member = await findLinkedMember(kind, intranetId, email, acronym);
  if (!member && acronym) {
    // Two sign-ins of the same member can race: the unique indexes (acronym
    // and intranet id) settle it, and only the one that inserted records
    // the creation.
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(members)
        .values(newLinkedMember(kind, acronym, external, new Date(), email))
        .onConflictDoNothing()
        .returning();
      if (row) {
        await recordAudit(tx, {
          actor: null,
          source: "intranet",
          action: AUDIT_ACTIONS.MEMBER_CREATE,
          targetType: "member",
          targetId: row.id,
          after: { ...memberAuditState(row), reason: "sign_in_link" },
        });
      }
      return row ?? null;
    });
    member =
      created ?? (await findLinkedMember(kind, intranetId, email, acronym));
    if (created) logInfo("members.link", { action: "member created", acronym });
  }
  if (!member) return null;
  // A member with the account's email is its own, whatever id it stores
  // (the account was recreated; the next roster sync stores the new id).
  const sameEmail = email !== null && member.email === email;
  if (
    !sameEmail &&
    acronymHeldByAnotherAccount(
      intranetId,
      member.intranetId,
      email,
      member.email,
    )
  ) {
    logWarn("members.link", {
      reason: "acronym held by another intranet account",
      acronym,
      intranetId,
      memberIntranetId: member.intranetId,
    });
    return null;
  }
  if (!canLinkToMember(kind, member.kind)) {
    logWarn("members.link", {
      reason: "acronym held by a member of another kind",
      acronym,
      kind: member.kind,
    });
    return null;
  }

  // Only over the link read above: a manual link an admin saved in the
  // meantime wins. The audit row is written only when the link changed.
  const linkedMemberId = member.id;
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(users)
      .set({ memberId: linkedMemberId })
      .where(
        sql`${users.id} = ${userId} and ${users.memberId} is not distinct from ${account.memberId} and ${users.memberId} is distinct from ${linkedMemberId}`,
      )
      .returning({ id: users.id });
    if (changed.length > 0) {
      await recordAudit(tx, {
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.USER_MEMBER_LINK,
        targetType: "user",
        targetId: userId,
        before: { memberId: account.memberId },
        after: { memberId: linkedMemberId, reason: "role_sync" },
      });
    }
  });
  return member.id;
}
