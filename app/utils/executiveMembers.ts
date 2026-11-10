import {
  GENERIC_EXECUTIVE_MEMBER,
  GENERIC_EXECUTIVE_MEMBER_ID,
} from "~~/shared/constants/domain";

/**
 * The generic "CEA" the server answers instead of an executive area to an
 * account that may not see the areas (docs/design.md, "Who sees the
 * executive areas"). It is a stand-in, never a member: it names the areas
 * already on a document or an amendment and filters by them, but nobody adds
 * it or removes it (the server refuses the first with 422 `executive_member`
 * and ignores the second).
 */

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
 * The co-authors to send when the author says it presents the amendment
 * alone: none, except the generic "CEA" already among them, which only the
 * CEA or the Secretaría take out.
 */
export function keptGenericExecutive(ids: readonly string[]): string[] {
  return ids.includes(GENERIC_EXECUTIVE_MEMBER_ID)
    ? [GENERIC_EXECUTIVE_MEMBER_ID]
    : [];
}

/** "CEA" for the generic id, which no member list names; null otherwise. */
export function genericExecutiveAcronym(
  id: string | null | undefined,
): string | null {
  return isGenericExecutiveMember(id) ? GENERIC_EXECUTIVE_MEMBER.acronym : null;
}
