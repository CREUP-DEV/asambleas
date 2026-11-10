import {
  GENERIC_EXECUTIVE_MEMBER,
  GENERIC_EXECUTIVE_MEMBER_ID,
} from "~~/shared/constants/domain";
import { MEMBER_LIST_FOR_AMENDMENT } from "~~/shared/utils/schemas/member";

/**
 * The generic "CEA" the server answers instead of an executive area to an
 * account that may not see the areas (docs/design.md, "Who sees the
 * executive areas"). It is a stand-in, never a member: it names the areas
 * already on a document or an amendment and filters by them, and nobody
 * adds it (422 `executive_member`). On a document nobody removes it either
 * (the server keeps the areas whatever is sent). On an amendment draft it
 * stands for every area among the authors: sent back they stay, left out
 * they all go.
 */

/**
 * The query of GET /api/members for the composers of amendments and
 * transactionals, and only for them: the one list where an account that
 * does not see the executive areas gets them, to name them as authors.
 */
export const AMENDMENT_AUTHORS_QUERY = {
  for: MEMBER_LIST_FOR_AMENDMENT,
} as const;

/** Whether the id is the generic "CEA", not a member. */
export function isGenericExecutiveMember(
  id: string | null | undefined,
): boolean {
  return id === GENERIC_EXECUTIVE_MEMBER_ID;
}

/**
 * The members a picker may offer to add (co-authors, co-presenters, who
 * presents): everyone but the generic "CEA". Accounts that see the areas
 * never get it, so their lists stay as they are.
 */
export function addableMembers<T extends { id: string }>(
  members: readonly T[],
): T[] {
  return members.filter((member) => !isGenericExecutiveMember(member.id));
}

/**
 * The ids a viewer cannot take out of a list: the generic "CEA" when it is
 * there, on top of the ones the caller already fixes.
 */
export function withFixedGenericExecutive(
  fixedIds: readonly string[],
  currentIds: readonly string[],
): string[] {
  return currentIds.includes(GENERIC_EXECUTIVE_MEMBER_ID) &&
    !fixedIds.includes(GENERIC_EXECUTIVE_MEMBER_ID)
    ? [...fixedIds, GENERIC_EXECUTIVE_MEMBER_ID]
    : [...fixedIds];
}

/**
 * The generic "CEA" a stored amendment draft has among its authors, as the
 * list to offer it in its picker (empty without it): it names the areas
 * already there, and taking it out takes them all out.
 */
export function seededGenericExecutive(ids: readonly string[]): string[] {
  return ids.includes(GENERIC_EXECUTIVE_MEMBER_ID)
    ? [GENERIC_EXECUTIVE_MEMBER_ID]
    : [];
}

/** The executive areas of a member list, to offer them apart. */
export function executiveMembersOf<T extends { id: string; kind: string }>(
  members: readonly T[],
): T[] {
  return addableMembers(members).filter(
    (member) => member.kind === "executive",
  );
}

/** "CEA" for the generic id, which no member list names; null otherwise. */
export function genericExecutiveAcronym(
  id: string | null | undefined,
): string | null {
  return isGenericExecutiveMember(id) ? GENERIC_EXECUTIVE_MEMBER.acronym : null;
}
