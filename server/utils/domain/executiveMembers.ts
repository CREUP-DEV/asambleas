import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { members } from "../../db/schema";
import { GENERIC_EXECUTIVE_MEMBER_ID } from "~~/shared/constants/domain";
import type { Actor } from "./actor";
import { canSeeExecutiveMembers, type ExecutiveMask } from "./visibility";

/**
 * The executive areas (members of kind "executive") and the accounts that
 * may not see them (canSeeExecutiveMembers, visibility.ts): the loader of
 * what is hidden from an actor, and the rules for the members such an actor
 * names in a body. docs/design.md, "Who sees the executive areas".
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `data.reason` of the 422 that refuses an executive area in a body. */
export const EXECUTIVE_MEMBER_REFUSED_REASON = "executive_member";

export const EXECUTIVE_MEMBER_REFUSED_MESSAGE =
  "No puedes añadir a la CEA. Pídeselo a la propia CEA o a la Secretaría.";

/**
 * `data.reason` of the 422 for the generic id as main author or main
 * presenter when it cannot say which area: nothing was added, so it has its
 * own wording.
 */
export const EXECUTIVE_MAIN_REFUSED_REASON = "executive_main";

export const EXECUTIVE_MAIN_REFUSED_MESSAGE =
  "No puedes elegir a la CEA como principal. Pídeselo a la CEA o a la Secretaría.";

/** Ids of every executive area, active or not. */
export async function loadExecutiveMemberIds(
  executor: Executor = db,
): Promise<Set<string>> {
  const rows = await executor
    .select({ id: members.id })
    .from(members)
    .where(eq(members.kind, "executive"));
  return new Set(rows.map((row) => row.id));
}

/**
 * What is hidden from the actor: null when it sees the areas, otherwise the
 * ids of all of them (redactMemberId, redactPayloadMembers).
 */
export async function loadExecutiveMask(
  actor: Actor,
  executor: Executor = db,
): Promise<ExecutiveMask> {
  if (canSeeExecutiveMembers(actor)) return null;
  return loadExecutiveMemberIds(executor);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The members a body lists (co-authors, co-presenters) once the rule of the
 * areas is applied, or "refused" (422 `executive_member`):
 * - the generic id is never a member. An actor who sees the areas may not
 *   send it at all;
 * - an actor who does not see them cannot add an area, by its real id or by
 *   the generic one, and cannot remove one either: the areas already there
 *   (`current`) always stay, whatever the list says, since that actor reads
 *   them all as one "CEA" and cannot tell which one it would drop. The
 *   generic id is then only a stand-in for them. The CEA itself or the
 *   Secretaría add and remove areas.
 * A list left out (undefined) stays left out.
 */
export function planListedMembers(input: {
  mask: ExecutiveMask;
  requested: readonly string[] | undefined;
  /** Member ids the entity has now; empty on a create. */
  current: readonly string[];
}): string[] | undefined | "refused" {
  const { mask, requested, current } = input;
  if (requested === undefined) return undefined;
  const generic = requested.includes(GENERIC_EXECUTIVE_MEMBER_ID);
  if (!mask) return generic ? "refused" : [...requested];

  const kept = current.filter((id) => mask.has(id));
  if (generic && kept.length === 0) return "refused";
  const named = requested.filter((id) => id !== GENERIC_EXECUTIVE_MEMBER_ID);
  if (named.some((id) => mask.has(id) && !current.includes(id))) {
    return "refused";
  }
  return unique([...named, ...kept]);
}

/**
 * The one member a body names (main author, main presenter) under the same
 * rule. For an actor who does not see the areas the generic id means the
 * area that already holds that place (`currentMain`), or the only area on
 * the entity; with several areas and none of them in that place it cannot
 * say which ("ambiguous", 422 `executive_main`), and with none it is
 * refused. Null and undefined pass through.
 */
export function planNamedMember(input: {
  mask: ExecutiveMask;
  requested: string | null | undefined;
  /** Member ids the entity has now, the main one included; empty on a create. */
  current: readonly string[];
  currentMain: string | null | undefined;
}): string | null | undefined | "refused" | "ambiguous" {
  const { mask, requested, current, currentMain } = input;
  if (!requested) return requested;
  if (requested === GENERIC_EXECUTIVE_MEMBER_ID) {
    if (!mask) return "refused";
    if (currentMain && mask.has(currentMain)) return currentMain;
    const areas = unique(current.filter((id) => mask.has(id)));
    if (areas.length === 0) return "refused";
    return areas.length === 1 ? areas[0]! : "ambiguous";
  }
  if (mask?.has(requested) && !current.includes(requested)) return "refused";
  return requested;
}

export function refuseExecutiveMember(): never {
  throw createError({
    statusCode: 422,
    message: EXECUTIVE_MEMBER_REFUSED_MESSAGE,
    data: { reason: EXECUTIVE_MEMBER_REFUSED_REASON },
  });
}

export function refuseExecutiveMain(): never {
  throw createError({
    statusCode: 422,
    message: EXECUTIVE_MAIN_REFUSED_MESSAGE,
    data: { reason: EXECUTIVE_MAIN_REFUSED_REASON },
  });
}

/**
 * Applies planListedMembers and planNamedMember to the members of a body
 * and answers 422 `executive_member` when either refuses, or 422
 * `executive_main` when only the main one cannot be told. The database is
 * read only when the body names a member.
 */
export async function resolveBodyMembers<
  Listed extends readonly string[] | undefined,
  Named extends string | null | undefined,
>(
  actor: Actor,
  input: {
    listed: Listed;
    named: Named;
    /** Every member the entity has now, the main one included. */
    current: readonly string[];
    currentMain: string | null | undefined;
    /**
     * The members the list holds now, when it is not all of them (the
     * co-presenters of a document, which never include the main one).
     */
    listedCurrent?: readonly string[];
  },
  executor: Executor = db,
): Promise<{
  listed: Listed extends undefined ? undefined : string[];
  named: Named;
}> {
  type Result = {
    listed: Listed extends undefined ? undefined : string[];
    named: Named;
  };
  if (input.listed === undefined && !input.named) {
    return { listed: undefined, named: input.named } as Result;
  }
  const mask = await loadExecutiveMask(actor, executor);
  const listed = planListedMembers({
    mask,
    requested: input.listed,
    current: input.listedCurrent ?? input.current,
  });
  // The main one may be an area the list keeps.
  const named = planNamedMember({
    mask,
    requested: input.named,
    current: input.current,
    currentMain: input.currentMain,
  });
  if (listed === "refused" || named === "refused") refuseExecutiveMember();
  if (named === "ambiguous") refuseExecutiveMain();
  return { listed, named } as Result;
}
