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
 * (the server keeps the areas whatever is sent). An amendment body never
 * carries it (422 `executive_author`): whoever edits a draft reads its real
 * authors in the composer (`hidesExecutiveAuthors`) and names every office
 * by its real id.
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
 * Whether the authors of a draft, as the viewer reads them, hide executive
 * offices behind the generic "CEA". Its composer then needs the real ones
 * (GET .../amendments/[amendment]/authors) before it opens; otherwise the
 * ones it already has are the real ones.
 */
export function hidesExecutiveAuthors(
  authors: readonly { id: string }[],
): boolean {
  return authors.some((author) => isGenericExecutiveMember(author.id));
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
