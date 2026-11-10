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
 * - an actor who does not see them cannot add an area and cannot remove one
 *   either: the areas already there (`current`) always stay, whatever the
 *   list says, since that actor reads them all as one "CEA" and cannot tell
 *   which one it would drop. The generic id is then only a stand-in for
 *   them. A real id of an area is refused whether or not that area is
 *   there: accepting the ones that are would tell which area hides behind
 *   the "CEA" (such an account may know the ids, GET
 *   /api/members?for=amendment). The CEA itself or the Secretaría add and
 *   remove areas.
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
  if (named.some((id) => mask.has(id))) return "refused";
  return unique([...named, ...kept]);
}

/**
 * The one member a body names (main author, main presenter) under the same
 * rule. For an actor who does not see the areas the generic id means the
 * area that already holds that place (`currentMain`), or the only area on
 * the entity; with several areas and none of them in that place it cannot
 * say which ("ambiguous", 422 `executive_main`), and with none it is
 * refused. A real id of an area is refused for that actor whether or not
 * the area is there (see planListedMembers). Null and undefined pass
 * through.
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
  if (mask?.has(requested)) return "refused";
  return requested;
}

export function refuseExecutiveMember(): never {
  throw createError({
    statusCode: 422,
    message: EXECUTIVE_MEMBER_REFUSED_MESSAGE,
    data: { reason: EXECUTIVE_MEMBER_REFUSED_REASON },
  });
}

/**
 * `data.reason` of the 422 for the generic id in the body of an amendment
 * or a transactional when no area stands behind it. There the account adds
 * the areas itself, by name, so it has its own wording.
 */
export const EXECUTIVE_AUTHOR_REFUSED_REASON = "executive_author";

export const EXECUTIVE_AUTHOR_REFUSED_MESSAGE =
  "«CEA» solo mantiene los cargos de la CEA que ya la presentan. Añade el cargo por su nombre.";

/**
 * `data.reason` of the 422 for an area named as main author by an account
 * that does not see the areas, when the same body does not list it among
 * the authors.
 */
export const EXECUTIVE_AUTHOR_MAIN_REFUSED_REASON = "executive_author_main";

export const EXECUTIVE_AUTHOR_MAIN_REFUSED_MESSAGE =
  "Para que un cargo de la CEA sea el autor principal, márcalo también entre quienes la presentan.";

export function refuseExecutiveAuthor(): never {
  throw createError({
    statusCode: 422,
    message: EXECUTIVE_AUTHOR_REFUSED_MESSAGE,
    data: { reason: EXECUTIVE_AUTHOR_REFUSED_REASON },
  });
}

export function refuseExecutiveAuthorMain(): never {
  throw createError({
    statusCode: 422,
    message: EXECUTIVE_AUTHOR_MAIN_REFUSED_MESSAGE,
    data: { reason: EXECUTIVE_AUTHOR_MAIN_REFUSED_REASON },
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

// Amendments -----------------------------------------------------------------
// The CEA presents amendments and transactionals too, and any member may
// present one with it. An account that does not see the areas reads their
// real list only while it composes one (GET /api/members?for=amendment) and
// names them by their real ids; what it reads back is the generic "CEA".
// Since that account knows every real id, no answer here may depend on
// which areas the amendment already has: only on how the body names them.

/**
 * The authors an amendment body lists once the rule of the areas is
 * applied, or "refused" (422 `executive_author`):
 * - an actor who sees the areas names them as any member and never sends
 *   the generic id;
 * - an actor who does not see them may name any area by its real id. The
 *   generic id stands for the areas already there (`current`), all of them,
 *   since that actor cannot tell them apart: with it they stay, without it
 *   they go, except the ones the list names. The generic id with no area
 *   there is refused: it is never a member.
 * A list left out (undefined) stays left out.
 */
export function planAmendmentAuthors(input: {
  mask: ExecutiveMask;
  requested: readonly string[] | undefined;
  /** Member ids the amendment has now; empty on a create. */
  current: readonly string[];
}): string[] | undefined | "refused" {
  const { mask, requested, current } = input;
  if (requested === undefined) return undefined;
  const generic = requested.includes(GENERIC_EXECUTIVE_MEMBER_ID);
  if (!mask) return generic ? "refused" : [...requested];
  const kept = current.filter((id) => mask.has(id));
  if (generic && kept.length === 0) return "refused";
  const named = requested.filter((id) => id !== GENERIC_EXECUTIVE_MEMBER_ID);
  return unique([...named, ...(generic ? kept : [])]);
}

/**
 * The main author an amendment body names under the same rule. An actor who
 * sees the areas names any member by its id and never sends the generic
 * one. For an actor who does not see them:
 * - an area by its real id passes only when the same body lists it among
 *   the authors (`listed`); otherwise "unlisted" (422
 *   `executive_author_main`), whether or not that area is already an
 *   author, so the answer never tells which area the amendment has;
 * - the generic id means one of the areas that stay behind the generic
 *   entry (`current`, kept by a list with the generic id or by no list):
 *   the one that is the main author now, otherwise the first of them. Which
 *   areas the body names by their ids never changes that choice, and
 *   several areas are no error, so the answer tells neither which they are
 *   nor how many. With none behind it, it means the first area the list
 *   names, and with none at all it is refused.
 * Null and undefined pass through.
 */
export function planAmendmentMainAuthor(input: {
  mask: ExecutiveMask;
  requested: string | null | undefined;
  /** The authors the body lists, as it sent them; undefined with no list. */
  listed: readonly string[] | undefined;
  /** Member ids the amendment has now; empty on a create. */
  current: readonly string[];
  currentMain: string | null | undefined;
}): string | null | undefined | "refused" | "unlisted" {
  const { mask, requested, listed, current, currentMain } = input;
  if (!requested) return requested;
  if (requested !== GENERIC_EXECUTIVE_MEMBER_ID) {
    if (mask?.has(requested) && !listed?.includes(requested)) return "unlisted";
    return requested;
  }
  if (!mask) return "refused";
  const keeps =
    listed === undefined || listed.includes(GENERIC_EXECUTIVE_MEMBER_ID);
  const kept = keeps ? unique(current.filter((id) => mask.has(id))) : [];
  if (kept.length > 0) {
    return currentMain && kept.includes(currentMain) ? currentMain : kept[0]!;
  }
  const named = unique((listed ?? []).filter((id) => mask.has(id)));
  return named[0] ?? "refused";
}

/**
 * Applies planAmendmentAuthors and planAmendmentMainAuthor to the body of
 * an amendment or a transactional (422 `executive_author` or
 * `executive_author_main`). The database is read only when the body names
 * a member.
 */
export async function resolveAmendmentBodyMembers<
  Listed extends readonly string[] | undefined,
  Named extends string | null | undefined,
>(
  actor: Actor,
  input: {
    listed: Listed;
    named: Named;
    /** Every author the amendment has now, the main one included. */
    current: readonly string[];
    currentMain: string | null | undefined;
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
  const listed = planAmendmentAuthors({
    mask,
    requested: input.listed,
    current: input.current,
  });
  if (listed === "refused") refuseExecutiveAuthor();
  const named = planAmendmentMainAuthor({
    mask,
    requested: input.named,
    listed: input.listed,
    current: input.current,
    currentMain: input.currentMain,
  });
  if (named === "refused") refuseExecutiveAuthor();
  if (named === "unlisted") refuseExecutiveAuthorMain();
  return { listed, named } as Result;
}
