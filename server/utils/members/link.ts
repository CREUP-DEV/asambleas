import { sql } from "drizzle-orm";
import { db } from "../../db";
import { members, users } from "../../db/schema";
import { logInfo } from "../core/logger";
import type { RosterKind } from "./roster";

/** Intranet account types that are members themselves (intranet `users.type`). */
export const INTRANET_MEMBER_TYPES: ReadonlyMap<string, RosterKind> = new Map<
  string,
  RosterKind
>([
  ["Asociado", "asociado"],
  ["Sectorial", "sectorial"],
]);

export interface ExternalMemberIdentity {
  /** Intranet `type`, e.g. "Asociado". */
  role: string;
  initials: string | null;
  name: string | null;
  university: string | null;
}

const ACRONYM_MAX_LENGTH = 20;

function findMemberIdByAcronym(acronym: string): Promise<string | null> {
  return db
    .select({ id: members.id })
    .from(members)
    .where(sql`lower(${members.acronym}) = lower(${acronym})`)
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
}

/**
 * Links `users.memberId` after a successful role sync, when the intranet
 * account is an Asociado or a Sectorial: in the intranet that account *is*
 * the member, and `initials` is its acronym. The member is created (source
 * intranet) when the roster has not been synced yet; the next roster sync
 * fills in its denomination and region.
 *
 * Other external roles leave `memberId` alone: it may have been set by hand,
 * for example for an executive area.
 *
 * Returns the linked member id, or null when nothing was linked.
 */
export async function linkUserToIntranetMember(
  userId: string,
  external: ExternalMemberIdentity,
): Promise<string | null> {
  const kind = INTRANET_MEMBER_TYPES.get(external.role);
  const acronym = external.initials
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, ACRONYM_MAX_LENGTH);
  if (!kind || !acronym) return null;

  let memberId = await findMemberIdByAcronym(acronym);
  if (!memberId) {
    // Two sign-ins of the same member can race: the unique index settles it.
    await db
      .insert(members)
      .values({
        kind,
        acronym,
        name: external.name?.trim().slice(0, 200) || acronym,
        university:
          kind === "asociado"
            ? external.university?.trim().slice(0, 200) || null
            : null,
        source: "intranet",
        active: true,
        syncedAt: new Date(),
      })
      .onConflictDoNothing({ target: members.acronym });
    memberId = await findMemberIdByAcronym(acronym);
    if (memberId)
      logInfo("members.link", { action: "member created", acronym });
  }
  if (!memberId) return null;

  await db
    .update(users)
    .set({ memberId })
    .where(
      sql`${users.id} = ${userId} and ${users.memberId} is distinct from ${memberId}`,
    );
  return memberId;
}
