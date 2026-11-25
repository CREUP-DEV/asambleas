// The Actor of server tests, built by the production constructor
// (buildActor), so a test follows the rules every Actor follows: an Admin
// passes every `can`, the member is the user's. Kept out of server/utils so
// that Nitro never scans it. A suite that imports it must stub what
// domain/actor.ts loads (the database, requireAuth), as the domain suites
// already do; one that mocks domain/actor.ts must keep `buildActor` (spread
// the original module).
import { buildActor, type Actor } from "../utils/domain/actor";
import type { ImpersonationContext } from "../utils/auth/impersonation";
import type { AuthUserWithRole } from "../utils/auth/requireAuth";
import {
  ALL_PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { MemberKind } from "~~/shared/constants/domain";

/** The user id of testActor unless one is given: 32 characters, like better-auth's. */
export const TEST_ACTOR_ID = "u".repeat(32);

export interface TestActorOptions {
  /** The user's id (TEST_ACTOR_ID). */
  id?: string;
  /** The role's name (none by default); SYSTEM_ROLES.ADMIN makes an Admin. */
  role?: string | null;
  /**
   * The effective permissions. Default: none, or every key for an Admin,
   * as getEffectivePermissions lists them.
   */
  permissions?: readonly (PermissionKey | string)[];
  memberId?: string | null;
  memberKind?: MemberKind | null;
  impersonation?: ImpersonationContext | null;
  /** Any other field of the user (name, email, initials). */
  user?: Partial<AuthUserWithRole>;
}

export function testActor(options: TestActorOptions = {}): Actor {
  const role = options.role ?? null;
  const memberId = options.memberId ?? null;
  const permissions =
    options.permissions ??
    (role === SYSTEM_ROLES.ADMIN ? ALL_PERMISSION_KEYS : []);
  return buildActor({
    user: {
      id: options.id ?? TEST_ACTOR_ID,
      name: "Test",
      email: "test@example.org",
      image: null,
      roleId: role ? `role-${role}` : null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      lastRoleSyncAt: null,
      ...options.user,
      memberId,
      role: role ? { id: `role-${role}`, name: role } : null,
    },
    permissions: [...permissions] as PermissionKey[],
    memberKind: options.memberKind ?? null,
    impersonation: options.impersonation ?? null,
  });
}
