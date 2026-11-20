/**
 * Which amendments a partial read of a document's list
 * (listDocumentAmendmentsByIds) must build and look at, so each DTO it
 * sends is the one the full list would send. Pure, so it is unit-tested on
 * its own (amendmentDependencies.test.ts).
 *
 * What one amendment's DTO (buildAmendmentDtos) reads of others:
 * - a transactional, where the amendments it groups stand (`can`, through
 *   transactionalSourcesOpen) and whether the reader sees them
 *   (`sourceIds`);
 * - an amendment, whether the reader sees the transactionals over it
 *   (`transactionalIds`);
 * - a transactional with an inclusion under way, whether the reader sees
 *   the amendments it would add (`openRevision.addedSourceIds`).
 * Nothing else: relations and wordings belong to the list, not to a DTO.
 */

/** The links of a loaded amendment (LoadedAmendment) read here. */
export interface LinkedAmendmentRow {
  id: string;
  sources: readonly { sourceId: string }[];
  derived: readonly { transactionalId: string }[];
}

/**
 * The amendments linked to `rows` (the ones a transactional among them
 * groups, the transactionals over any of them) that are not among them,
 * once each, in the order met.
 */
export function linkedAmendmentIds(
  rows: readonly LinkedAmendmentRow[],
  extra: readonly string[] = [],
): string[] {
  const own = new Set(rows.map((row) => row.id));
  const linked = new Set<string>();
  const add = (id: string) => {
    if (!own.has(id)) linked.add(id);
  };
  for (const row of rows) {
    for (const source of row.sources) add(source.sourceId);
    for (const derived of row.derived) add(derived.transactionalId);
  }
  for (const id of extra) add(id);
  return [...linked];
}

/**
 * Of the amendments asked for, those the read does not send: deleted, of
 * another document or hidden from the reader, never told apart. Never the
 * ones added for them, which would name a hidden transactional over a
 * visible amendment.
 */
export function goneAmendmentIds(
  asked: Iterable<string>,
  sent: Iterable<string>,
): string[] {
  const kept = new Set(sent);
  return [...new Set(asked)].filter((id) => !kept.has(id));
}
