import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import { HEADCOUNT_GUEST_ROLES } from "~~/shared/constants/roles";
import type {
  HeadcountExpectedDto,
  HeadcountExpectedStatus,
} from "~~/shared/types/api";
import { db } from "../../db";
import { members, roles, users } from "../../db/schema";
import { logWarn } from "../core/logger";
import {
  INTRANET_TIMEOUT_MS,
  getIntranetApiBaseUrl,
  intranetAuthHeaders,
  intranetUrl,
} from "../members/intranet";
import { isTooLarge, readCapped } from "../seating/intranet";
import type { AssemblyRow } from "./assemblies";

/**
 * Who is expected at a headcount: the Intranet accounts with somebody
 * registered for the assembly's event (`GET {base}/asambleas/{type}/
 * {number}/inscritos`, docs/intranet.md), as the councils and sectorials
 * and the guest accounts they are here. The Mesa's form marks them, so it
 * sees at a glance who should be in the room (user's decision of
 * 2026-11-18). The route carries account ids only, never a person.
 *
 * The Intranet is asked at most once a minute per assembly, whatever the
 * number of Mesa devices: the answer is kept in this process's memory
 * (`EXPECTED_TTL_MS`) and only the ids are mapped again on every read, so a
 * member linked meanwhile shows. A failure is kept as long, and the form
 * says how the call went (`status`), never blocking the count.
 */

export const EXPECTED_TTL_MS = 60_000;
/** Account ids of one event: a few hundred at most. */
const EXPECTED_MAX_BYTES = 1024 * 1024;

const registeredResponseSchema = z.object({
  account_ids: z.array(z.number().int().positive()).max(50_000),
});
const notFoundBodySchema = z.strictObject({ error: z.literal("not_found") });

/** How the Intranet answered, with the account ids when it did. */
export type RegisteredFetch =
  | { status: "ok"; accountIds: number[] }
  | { status: Exclude<HeadcountExpectedStatus, "ok"> };

/** `asambleas/AGO/80/inscritos`. */
export function registeredPath(type: AssemblyType, number: number): string {
  return `asambleas/${type.toUpperCase()}/${String(number)}/inscritos`;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Reads the accounts registered for an assembly's Intranet event. Never
 * throws: `not_found` is exactly `{"error":"not_found"}` (no event carries
 * the pair), `unavailable` any other 404 (an Intranet without the route),
 * `failed` anything else that went wrong. Logs say how it went, never an id.
 */
export async function fetchRegisteredAccounts(
  type: AssemblyType,
  number: number,
): Promise<RegisteredFetch> {
  const base = getIntranetApiBaseUrl();
  if (!base) return { status: "unconfigured" };
  const fail = (reason: string, status: number | null): RegisteredFetch => {
    logWarn("headcounts.intranet", { outcome: "failed", reason, status });
    return { status: "failed" };
  };
  try {
    const response = await fetch(
      intranetUrl(base, registeredPath(type, number)),
      {
        headers: { Accept: "application/json", ...intranetAuthHeaders() },
        signal: AbortSignal.timeout(INTRANET_TIMEOUT_MS),
      },
    );
    const body = await readCapped(response, EXPECTED_MAX_BYTES);
    if (isTooLarge(body)) return fail("too_large", response.status);
    if (response.status === 404) {
      const notFound =
        !response.redirected &&
        notFoundBodySchema.safeParse(parseJson(body)).success;
      logWarn("headcounts.intranet", {
        outcome: notFound ? "not_found" : "unavailable",
      });
      return { status: notFound ? "not_found" : "unavailable" };
    }
    if (!response.ok) return fail("status", response.status);
    const parsed = registeredResponseSchema.safeParse(parseJson(body));
    if (!parsed.success) return fail("invalid_payload", response.status);
    return { status: "ok", accountIds: [...new Set(parsed.data.account_ids)] };
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return fail(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      null,
    );
  }
}

interface CachedFetch {
  at: number;
  result: Promise<RegisteredFetch>;
}

/** By assembly, type and number: a renumbered assembly asks again. */
const cache = new Map<string, CachedFetch>();

/** Drops what this process remembers (tests). */
export function clearExpectedCache(): void {
  cache.clear();
}

/** The Intranet's answer, at most once a minute per assembly. */
function cachedRegistered(
  assembly: Pick<AssemblyRow, "id" | "type" | "number">,
  now: number,
): { at: number; result: Promise<RegisteredFetch> } {
  const key = `${assembly.id}|${assembly.type}|${String(assembly.number)}`;
  const kept = cache.get(key);
  if (kept && now - kept.at < EXPECTED_TTL_MS) return kept;
  const entry = {
    at: now,
    result: fetchRegisteredAccounts(assembly.type, assembly.number),
  };
  cache.set(key, entry);
  return entry;
}

/**
 * Who the Mesa's form marks as expected: the active councils and
 * sectorials and the guest accounts (HEADCOUNT_GUEST_ROLES, with access)
 * whose Intranet id has somebody registered. Only for the Mesa (the
 * endpoint checks session:moderate).
 */
export async function loadExpectedAttendance(
  assembly: Pick<AssemblyRow, "id" | "type" | "number">,
  now: number = Date.now(),
): Promise<HeadcountExpectedDto> {
  const { at, result } = cachedRegistered(assembly, now);
  const fetched = await result;
  const checkedAt = new Date(at).toISOString();
  if (fetched.status !== "ok") {
    return { status: fetched.status, memberIds: [], guestIds: [], checkedAt };
  }
  if (fetched.accountIds.length === 0) {
    return { status: "ok", memberIds: [], guestIds: [], checkedAt };
  }
  const [memberRows, guestRows] = await Promise.all([
    db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          inArray(members.intranetId, fetched.accountIds),
          inArray(members.kind, ["asociado", "sectorial"]),
          eq(members.active, true),
        ),
      ),
    db
      .select({ id: users.id })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(
        and(
          inArray(users.intranetId, fetched.accountIds),
          inArray(roles.name, [...HEADCOUNT_GUEST_ROLES]),
          isNull(users.accessRevokedAt),
        ),
      ),
  ]);
  return {
    status: "ok",
    memberIds: memberRows.map((row) => row.id).sort(),
    guestIds: guestRows.map((row) => row.id).sort(),
    checkedAt,
  };
}
