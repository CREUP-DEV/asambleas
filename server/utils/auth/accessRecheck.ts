import {
  and,
  asc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { db } from "../../db";
import { roles, sessions, users } from "../../db/schema";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { PROTECTED_ROLES } from "~~/shared/constants/roles";
import { logError, logInfo, logWarn } from "../core/logger";
import { recordAudit } from "../domain/audit";
import {
  emailFingerprint,
  getRoleApiUrl,
  isRoleLookupAuthenticated,
  lookupIntranetRole,
  type IntranetRoleLookup,
} from "../members/intranet";
import { applyIntranetNotFound, type IntranetNotFoundResult } from "./roleSync";

/**
 * The daily access re-check: an account deleted in the Intranet loses access
 * even if it never signs in again. Sign-in already asks the Intranet
 * (checkSignInAccess), but a session lasts 7 days and is renewed every day
 * it is used, so an account that keeps its session alive would never be
 * asked. Once a day (server/utils/members/schedule.ts) every account that
 * has a live session, still has access, was known to the Intranet and holds
 * no protected role is looked up again, one at a time; an authenticated
 * `notFound` revokes it (applyIntranetNotFound). Nothing else changes: role
 * sync stays a sign-in matter, and `lastRoleSyncAt` is not touched.
 *
 * Mass safeguard: when the Intranet says it no longer has more than
 * max(3, 30%) of the accounts it answered for, nobody is revoked, the run
 * writes `users.access_recheck_blocked` and logs an error. An Intranet
 * pointed at an empty or partial database must not sign everybody out.
 */

/** Pause between two lookups: at most 120 a minute, well under the 300/min of `user/role`. */
export const ACCESS_RECHECK_DELAY_MS = 500;
/** Consecutive failed lookups after which the run gives up (the Intranet is down). */
export const ACCESS_RECHECK_MAX_CONSECUTIVE_FAILURES = 5;
/** The re-check may always revoke this many accounts... */
export const MASS_REVOCATION_MIN = 3;
/** ...or this share of the accounts the Intranet answered for, whichever is larger. */
export const MASS_REVOCATION_PERCENT = 30;

/**
 * Whether `notFound` of `checked` accounts is too many to revoke at once:
 * more than max(3, 30%). Integer math, so 3 of 10 is exactly 30% and passes.
 * Unlike the roster safeguard, revoking every account checked is allowed
 * when they are few: a single account with a live session that the
 * Intranet deleted must lose access.
 */
export function isMassRevocation(checked: number, notFound: number): boolean {
  if (checked <= 0 || notFound <= 0) return false;
  return (
    notFound > MASS_REVOCATION_MIN &&
    notFound * 100 > checked * MASS_REVOCATION_PERCENT
  );
}

/**
 * Whether the re-check can run: an authenticated role lookup is configured
 * (isRoleLookupAuthenticated). Only such a lookup can say an account was
 * deleted. Independent of NUXT_INTRANET_ROSTER_SYNC.
 */
export function isAccessRecheckEnabled(): boolean {
  const url = getRoleApiUrl();
  return url !== null && isRoleLookupAuthenticated(url);
}

/** An account the re-check looks up. */
export interface AccessRecheckCandidate {
  id: string;
  email: string;
}

/**
 * The accounts to look up: with access (`access_revoked_at` null), known to
 * the Intranet (knownToIntranet: an external type or an Intranet id), with
 * no PROTECTED_ROLES role (those are never revoked, and looking them up
 * would write `user.intranet_missing` every day) and with a session that
 * has not expired. In id order.
 */
export async function listAccessRecheckCandidates(
  now: Date = new Date(),
): Promise<AccessRecheckCandidate[]> {
  const liveSession = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, users.id), gt(sessions.expiresAt, now)));
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(
      and(
        isNull(users.accessRevokedAt),
        or(isNotNull(users.externalRole), isNotNull(users.intranetId)),
        or(isNull(roles.name), notInArray(roles.name, [...PROTECTED_ROLES])),
        exists(liveSession),
      ),
    )
    .orderBy(asc(users.id));
}

/**
 * How a re-check ended:
 * - `skipped`: no authenticated role lookup is configured;
 * - `aborted`: the Intranet failed ACCESS_RECHECK_MAX_CONSECUTIVE_FAILURES
 *   times in a row; nobody was revoked;
 * - `blocked`: too many not found (isMassRevocation); nobody was revoked;
 * - `applied`: every account the Intranet no longer has went through
 *   applyIntranetNotFound.
 * `checked` counts the accounts the Intranet answered for (found or not
 * found); `failed` the lookups that said nothing.
 */
export type AccessRecheckOutcome =
  | { status: "skipped" }
  | { status: "aborted"; checked: number; failed: number }
  | { status: "blocked"; checked: number; notFound: number; failed: number }
  | {
      status: "applied";
      checked: number;
      notFound: number;
      failed: number;
      revoked: number;
    };

/** What the re-check uses, replaceable in tests. */
export interface AccessRecheckDeps {
  candidates: () => Promise<AccessRecheckCandidate[]>;
  lookup: (email: string) => Promise<IntranetRoleLookup>;
  revoke: (
    userId: string,
    log: { accountRef: string | null },
  ) => Promise<IntranetNotFoundResult>;
  recordBlocked: (counts: {
    checked: number;
    notFound: number;
  }) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  delayMs: number;
  enabled: () => boolean;
}

async function recordRecheckBlocked(counts: {
  checked: number;
  notFound: number;
}): Promise<void> {
  await recordAudit(db, {
    actor: null,
    source: "intranet",
    action: AUDIT_ACTIONS.USERS_ACCESS_RECHECK_BLOCKED,
    targetType: "users",
    targetId: "intranet",
    after: { reason: "mass_not_found", ...counts },
  });
}

const defaultDeps: AccessRecheckDeps = {
  candidates: () => listAccessRecheckCandidates(),
  lookup: lookupIntranetRole,
  revoke: (userId, log) => applyIntranetNotFound(userId, log),
  recordBlocked: recordRecheckBlocked,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs: ACCESS_RECHECK_DELAY_MS,
  enabled: isAccessRecheckEnabled,
};

/**
 * Looks every candidate up again (listAccessRecheckCandidates), one at a
 * time with ACCESS_RECHECK_DELAY_MS between lookups, and revokes the ones
 * the Intranet deleted, unless they are too many (isMassRevocation). All
 * the lookups come first, so the safeguard sees the whole picture before
 * anything changes. Logs never carry an email (`accountRef` only). Throws
 * only on a database error.
 */
export async function recheckIntranetAccess(
  overrides: Partial<AccessRecheckDeps> = {},
): Promise<AccessRecheckOutcome> {
  const deps: AccessRecheckDeps = { ...defaultDeps, ...overrides };
  if (!deps.enabled()) {
    logInfo("access.recheck", { skipped: "no authenticated role lookup" });
    return { status: "skipped" };
  }

  const candidates = await deps.candidates();
  const missing: { id: string; accountRef: string | null }[] = [];
  let found = 0;
  let failed = 0;
  let failedInARow = 0;

  for (const [index, candidate] of candidates.entries()) {
    if (index > 0 && deps.delayMs > 0) await deps.sleep(deps.delayMs);
    const lookup = await deps.lookup(candidate.email);
    if (lookup.outcome === "ok") {
      found += 1;
      failedInARow = 0;
    } else if (lookup.outcome === "notFound") {
      missing.push({
        id: candidate.id,
        accountRef: emailFingerprint(candidate.email),
      });
      failedInARow = 0;
    } else {
      // `failed` was logged by lookupIntranetRole; `unconfigured` means the
      // configuration went away mid-run. Neither says anything.
      failed += 1;
      failedInARow += 1;
      if (failedInARow >= ACCESS_RECHECK_MAX_CONSECUTIVE_FAILURES) {
        const checked = found + missing.length;
        logWarn("access.recheck", {
          reason: "the intranet keeps failing; nobody revoked",
          candidates: candidates.length,
          checked,
          failed,
        });
        return { status: "aborted", checked, failed };
      }
    }
  }

  const checked = found + missing.length;
  if (isMassRevocation(checked, missing.length)) {
    await deps.recordBlocked({ checked, notFound: missing.length });
    logError(
      "access.recheck",
      "the intranet no longer has too many accounts; nobody revoked. Check that NUXT_INTRANET_API_URL points to the right Intranet",
      { checked, notFound: missing.length, failed },
    );
    return {
      status: "blocked",
      checked,
      notFound: missing.length,
      failed,
    };
  }

  let revoked = 0;
  for (const account of missing) {
    const result = await deps.revoke(account.id, {
      accountRef: account.accountRef,
    });
    if (result.kind === "revoked") revoked += 1;
  }
  logInfo("access.recheck", {
    candidates: candidates.length,
    checked,
    notFound: missing.length,
    failed,
    revoked,
  });
  return {
    status: "applied",
    checked,
    notFound: missing.length,
    failed,
    revoked,
  };
}
