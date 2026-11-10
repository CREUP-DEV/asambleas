import type { DocumentKind, MemberKind } from "../constants/domain";

/**
 * Document kinds a member of each kind may not present, as main presenter or
 * as co-presenter. Sectorials present documents and amendments like the
 * councils, except internal motions, which only members and the CEA present
 * (docs/proceso-asambleas.md, section 2); they may still amend one. The rule
 * follows the member a document is presented for, not the account's role,
 * so it binds everyone who acts for a sectorial, managers included.
 */
const BARRED_DOCUMENT_KINDS: Partial<
  Record<MemberKind, readonly DocumentKind[]>
> = {
  sectorial: ["internal_motion"],
};

/**
 * Whether a member of `memberKind` presents anything at all. Guests only
 * attend: they never present a document, co-present one, author an
 * amendment nor accept a transactional, whatever the account acting for
 * them may do.
 */
export function memberPresents(memberKind: MemberKind): boolean {
  return memberKind !== "guest";
}

/** Whether a member of `memberKind` may present a document of `documentKind`. */
export function memberMayPresent(
  documentKind: DocumentKind,
  memberKind: MemberKind,
): boolean {
  return (
    memberPresents(memberKind) &&
    !(BARRED_DOCUMENT_KINDS[memberKind] ?? []).includes(documentKind)
  );
}

/**
 * The members that may not present a document of `documentKind`. `kept`
 * holds the ids of the presenters the document already has: one that has
 * since become a guest (a council that left the association) keeps its
 * place, so the document can still be edited, but no guest is ever added.
 * The rule of the kind (a sectorial and an internal motion) binds them all.
 */
export function barredPresenters<T extends { kind: MemberKind; id?: string }>(
  documentKind: DocumentKind,
  members: readonly T[],
  kept: ReadonlySet<string> = new Set(),
): T[] {
  return members.filter((member) => {
    if (!memberPresents(member.kind)) {
      return member.id === undefined || !kept.has(member.id);
    }
    return !memberMayPresent(documentKind, member.kind);
  });
}
