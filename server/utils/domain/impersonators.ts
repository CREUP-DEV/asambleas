import { eq, inArray, sql } from "drizzle-orm";
import type { UserRef } from "~~/shared/types/api";
import { db } from "../../db";
import { impersonations, users } from "../../db/schema";

/**
 * Who sees that an act was really done by an Admin acting as its actor's
 * account (`impersonatedBy`): that very account and Admins, nobody else
 * (docs/design.md, "Impersonation").
 */
export function seesImpersonator(
  viewer: { user: { id: string }; isAdmin: boolean },
  actorUserId: string | null,
): boolean {
  return (
    viewer.isAdmin || (actorUserId !== null && actorUserId === viewer.user.id)
  );
}

/**
 * The Admin behind each impersonation, by impersonation id, named as the
 * activity lists name users (coalesce(external_name, name), never an email).
 * One query for the whole list; ids that are null or unknown are skipped.
 */
export async function loadImpersonators(
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, { adminUserId: string; admin: UserRef }>> {
  const unique = [
    ...new Set([...ids].filter((id): id is string => Boolean(id))),
  ];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: impersonations.id,
      adminUserId: users.id,
      name: sql<string>`coalesce(${users.externalName}, ${users.name})`,
    })
    .from(impersonations)
    .innerJoin(users, eq(users.id, impersonations.adminUserId))
    .where(inArray(impersonations.id, unique));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        adminUserId: row.adminUserId,
        admin: { id: row.adminUserId, name: row.name },
      },
    ]),
  );
}

/**
 * `impersonatedBy` of one recorded act for `viewer`: the Admin when the act
 * was done while acting as its actor and the viewer may know it
 * (seesImpersonator), null otherwise. The impersonation's own rows (done by
 * the Admin as themself) name nobody.
 */
export function impersonatedByFor(
  viewer: { user: { id: string }; isAdmin: boolean },
  row: { actorUserId: string | null; impersonationId: string | null },
  impersonators: ReadonlyMap<string, { adminUserId: string; admin: UserRef }>,
): UserRef | null {
  if (!row.impersonationId || !seesImpersonator(viewer, row.actorUserId)) {
    return null;
  }
  const found = impersonators.get(row.impersonationId);
  if (!found || found.adminUserId === row.actorUserId) return null;
  return found.admin;
}
