import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { members, users } from "../../db/schema";
import type {
  MemberKind,
  MemberSource,
} from "../../../shared/constants/domain";
import { logInfo, logWarn } from "../core/logger";

/** Member kinds an intranet account can act for. */
export type LinkedMemberKind = Extract<
  MemberKind,
  "asociado" | "sectorial" | "executive"
>;

/**
 * Intranet account types (intranet `users.type`) linked to a member by their
 * initials: Asociado and Sectorial accounts are the member itself, and a CEA
 * account acts for its executive area.
 */
export const INTRANET_MEMBER_TYPES: ReadonlyMap<string, LinkedMemberKind> =
  new Map<string, LinkedMemberKind>([
    ["Asociado", "asociado"],
    ["Sectorial", "sectorial"],
    ["CEA", "executive"],
  ]);

export interface ExternalMemberIdentity {
  /** Intranet `type`, e.g. "Asociado". */
  role: string;
  initials: string | null;
  name: string | null;
  university: string | null;
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
 * area (or an "other" member), never to a council or a sectorial that
 * happens to share its initials.
 */
export function canLinkToMember(
  kind: LinkedMemberKind,
  existingKind: MemberKind,
): boolean {
  if (kind !== "executive") return true;
  return existingKind === "executive" || existingKind === "other";
}

/**
 * The member created when none has the acronym yet. Councils and sectorials
 * come from the intranet roster, whose next sync fills in their details.
 * Executive areas are not in the roster: they are created as manual members,
 * so a roster sync never deactivates them, and named after their acronym,
 * since a CEA account may carry the name of the person rather than the area
 * (an admin renames it in the members page).
 */
export function newLinkedMember(
  kind: LinkedMemberKind,
  acronym: string,
  external: Pick<ExternalMemberIdentity, "name" | "university">,
  now = new Date(),
): {
  kind: LinkedMemberKind;
  acronym: string;
  name: string;
  university: string | null;
  source: MemberSource;
  active: boolean;
  syncedAt: Date | null;
} {
  const executive = kind === "executive";
  return {
    kind,
    acronym,
    name: executive
      ? acronym
      : external.name?.trim().slice(0, NAME_MAX_LENGTH) || acronym,
    university:
      kind === "asociado"
        ? external.university?.trim().slice(0, NAME_MAX_LENGTH) || null
        : null,
    source: executive ? "manual" : "intranet",
    active: true,
    syncedAt: executive ? null : now,
  };
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

function findMemberByAcronym(
  acronym: string,
): Promise<{ id: string; kind: MemberKind } | null> {
  return db
    .select({ id: members.id, kind: members.kind })
    .from(members)
    .where(sql`lower(${members.acronym}) = lower(${acronym})`)
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Links `users.memberId` after a successful role sync, when the intranet
 * account is an Asociado, a Sectorial or a CEA account, by its `initials`
 * (the member's acronym). The member is created when none has that acronym
 * yet (see newLinkedMember). A CEA account that already acts for a member
 * keeps it until its initials change (keepsCurrentLink); `previousInitials`
 * are the ones stored by the previous sync.
 *
 * Other external roles leave `memberId` alone: it may have been set by hand
 * (PUT /api/admin/users/[id]/member), for example for an account without
 * initials. Role sync clears it when the account stops acting for its
 * member (stopsActingForMember in roleSync.ts).
 *
 * Returns the linked member id, or null when nothing was linked.
 */
export async function linkUserToIntranetMember(
  userId: string,
  external: ExternalMemberIdentity,
  options: { previousInitials?: string | null } = {},
): Promise<string | null> {
  const kind = INTRANET_MEMBER_TYPES.get(external.role);
  const acronym = initialsToAcronym(external.initials);
  if (!kind || !acronym) return null;

  const [account] = await db
    .select({ memberId: users.memberId })
    .from(users)
    .where(eq(users.id, userId));
  if (!account) return null;
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

  let member = await findMemberByAcronym(acronym);
  if (!member) {
    // Two sign-ins of the same member can race: the unique index settles it.
    await db
      .insert(members)
      .values(newLinkedMember(kind, acronym, external))
      .onConflictDoNothing({ target: members.acronym });
    member = await findMemberByAcronym(acronym);
    if (member) logInfo("members.link", { action: "member created", acronym });
  }
  if (!member) return null;
  if (!canLinkToMember(kind, member.kind)) {
    logWarn("members.link", {
      reason: "acronym held by a member of another kind",
      acronym,
      kind: member.kind,
    });
    return null;
  }

  // Only over the link read above: a manual link an admin saved in the
  // meantime wins.
  await db
    .update(users)
    .set({ memberId: member.id })
    .where(
      sql`${users.id} = ${userId} and ${users.memberId} is not distinct from ${account.memberId} and ${users.memberId} is distinct from ${member.id}`,
    );
  return member.id;
}
