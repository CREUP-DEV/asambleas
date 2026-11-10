import type { DocumentKind, MemberKind } from "../constants/domain";

/**
 * Document kinds a member of each kind may not present, as main presenter or
 * as co-presenter. Sectorials and the other members (the CAS) present
 * documents and amendments like the councils, except internal motions,
 * which only members and the CEA present (docs/proceso-asambleas.md,
 * section 2); they may still amend one. The rule
 * follows the member a document is presented for, not the account's role,
 * so it binds everyone who acts for a sectorial, managers included.
 */
const BARRED_DOCUMENT_KINDS: Partial<
  Record<MemberKind, readonly DocumentKind[]>
> = {
  sectorial: ["internal_motion"],
  other: ["internal_motion"],
};

/** Whether a member of `memberKind` may present a document of `documentKind`. */
export function memberMayPresent(
  documentKind: DocumentKind,
  memberKind: MemberKind,
): boolean {
  return !(BARRED_DOCUMENT_KINDS[memberKind] ?? []).includes(documentKind);
}

/** The members that may not present a document of `documentKind`. */
export function barredPresenters<T extends { kind: MemberKind }>(
  documentKind: DocumentKind,
  members: readonly T[],
): T[] {
  return members.filter(
    (member) => !memberMayPresent(documentKind, member.kind),
  );
}
