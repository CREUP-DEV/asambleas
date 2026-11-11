/**
 * The reader of an agenda item's page: one published document on show at a
 * time, picked among the item's own, with the documents before and after it
 * in the order of the whole agenda, so "Siguiente" on the last document of
 * an item opens the first one of the next item that has any.
 */

/** Query key of the document on show: its slug. */
export const ITEM_READER_QUERY = "doc";

export interface ItemReaderPosition<D> {
  /** The item's documents the reader shows, in their order. */
  here: D[];
  /** The one on show; null when the item has none. */
  current: D | null;
  /** Its position among `here`, from 0; -1 without one. */
  index: number;
  /** The documents before and after it in the whole agenda. */
  previous: D | null;
  next: D | null;
}

/**
 * Where the reader stands. `ordered` holds every document it may show, in
 * the order of the agenda (documentsInAgendaOrder); `wanted` is the slug in
 * the address (an id works too), and anything else opens the item's first.
 */
export function itemReaderPosition<
  D extends { id: string; slug: string; agendaItemId: string },
>(
  ordered: readonly D[],
  itemId: string,
  wanted: string | null,
): ItemReaderPosition<D> {
  const here = ordered.filter((document) => document.agendaItemId === itemId);
  const current =
    (wanted
      ? here.find(
          (document) => document.slug === wanted || document.id === wanted,
        )
      : undefined) ??
    here[0] ??
    null;
  if (!current) {
    return { here, current: null, index: -1, previous: null, next: null };
  }
  const at = ordered.indexOf(current);
  return {
    here,
    current,
    index: here.indexOf(current),
    previous: ordered[at - 1] ?? null,
    next: ordered[at + 1] ?? null,
  };
}

/** How many documents an item shows as tabs before it turns to a menu. */
export const ITEM_READER_MAX_TABS = 5;
