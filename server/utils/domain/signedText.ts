/**
 * What a document's signing signs, its text in force (documentSigning.ts,
 * user's decisions of 2026-11-28): the approved one (consolidated) of a
 * text the assembly votes, the published one (base) of a text nothing
 * votes, a report say. Null while there is none: a voted text not approved
 * yet, a draft. Apart, with no imports, so the notices read it without
 * loading the signing.
 */
export function signedTextVersionId(document: {
  consolidatedVersionId: string | null;
  baseVersionId: string | null;
  voted: boolean;
}): string | null {
  return (
    document.consolidatedVersionId ??
    (document.voted ? null : document.baseVersionId)
  );
}
