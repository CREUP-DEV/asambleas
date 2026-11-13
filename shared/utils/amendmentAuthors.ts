import type { AmendmentStatus } from "../constants/domain";
import { amendmentCodeSeq } from "./amendmentCode";

/**
 * Correcting who presents an amendment: the Secretaría changes the authors
 * and the main author of an amendment or a transactional already presented,
 * in case it was presented wrong (POST .../[amendment]/authors).
 */

/**
 * Whether the authors of an amendment can be corrected now: presented and
 * undecided, in a document not voted yet. A draft is still its authors' to
 * edit. Who may do it (amendment:review) is checked apart.
 */
export function canChangeAmendmentAuthors(
  amendment: { status: AmendmentStatus },
  documentVoted: boolean,
): boolean {
  return !documentVoted && amendment.status === "submitted";
}

export interface AuthorsChange {
  /** Members added to the authors. */
  added: string[];
  /** Members that stop being authors. */
  removed: string[];
  /** The main author is another member. */
  mainChanged: boolean;
}

/**
 * What a correction changes, or null when it would leave the authors and
 * the main author as they are (the order of the lists does not count).
 */
export function authorsChange(input: {
  currentIds: readonly string[];
  currentMain: string | null;
  nextIds: readonly string[];
  nextMain: string | null;
}): AuthorsChange | null {
  const current = new Set(input.currentIds);
  const next = new Set(input.nextIds);
  const added = [...next].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !next.has(id));
  const mainChanged = input.currentMain !== input.nextMain;
  if (added.length === 0 && removed.length === 0 && !mainChanged) return null;
  return { added, removed, mainChanged };
}

/**
 * The number of a code an amendment held before (`previousCode` of an
 * `amendment_authors_changed` event) when it belongs to the sequence with
 * this prefix ("UGR2" or, from before, "CEUM 2"), otherwise null.
 */
export function formerMemberSeq(code: unknown, prefix: string): number | null {
  return amendmentCodeSeq(code, prefix);
}

/**
 * The members of one side of an `amendment_authors_changed` payload (`from`
 * or `to`: `{ authorMemberIds, mainAuthorId }`), named to be read: the main
 * author first, the others by name. Null when the side is missing or
 * malformed, or when a member cannot be named. `main` says whether the
 * first one is the main author of several (alone, it needs no mark).
 */
export function authorsChangeSide(
  side: unknown,
  nameOf: (memberId: string) => string | null,
): { names: string[]; main: boolean } | null {
  if (!side || typeof side !== "object") return null;
  const { authorMemberIds, mainAuthorId } = side as {
    authorMemberIds?: unknown;
    mainAuthorId?: unknown;
  };
  if (
    !Array.isArray(authorMemberIds) ||
    authorMemberIds.length === 0 ||
    !authorMemberIds.every((id): id is string => typeof id === "string")
  ) {
    return null;
  }
  const mainId =
    typeof mainAuthorId === "string" && authorMemberIds.includes(mainAuthorId)
      ? mainAuthorId
      : null;
  const named: { id: string; name: string }[] = [];
  for (const id of new Set(authorMemberIds)) {
    const name = nameOf(id);
    if (!name) return null;
    named.push({ id, name });
  }
  const others = named
    .filter((member) => member.id !== mainId)
    .map((member) => member.name)
    .sort((a, b) => a.localeCompare(b));
  const main = named.find((member) => member.id === mainId);
  return {
    names: [...(main ? [main.name] : []), ...others],
    main: Boolean(main) && named.length > 1,
  };
}
