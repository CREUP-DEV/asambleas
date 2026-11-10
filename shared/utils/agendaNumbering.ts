import { visibleAgendaItems, type TitleSource } from "./agendaSubmissions";

/**
 * The numbers of the agenda ("1", "2", "17.1"...). They are never stored:
 * every screen and every PDF computes them here, from the flat items.
 *
 * Everyone reads the same number for the same item. The numbers are the ones
 * a plain attendee reads, someone who sees only what is public: an item that
 * attendee does not receive (`unlisted`: the automatic sub-item of a document
 * that is not public yet) keeps its place in the list for whoever does
 * receive it, but carries no number and never shifts the numbers of its
 * siblings.
 *
 * Every function is pure and never mutates its input.
 */

export interface AgendaOrderItem {
  id: string;
  parentId: string | null;
  order: number;
  /**
   * A plain attendee does not receive the item (unlistedAgendaItemIds): it
   * has no number. Absent means listed.
   */
  unlisted?: boolean;
}

/** Siblings in display order. */
export function compareAgendaSiblings(
  a: AgendaOrderItem,
  b: AgendaOrderItem,
): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

/**
 * Effective parent of every item: the declared one, or null (root) when the
 * parent is missing or the declared chain loops back on itself.
 */
export function agendaEffectiveParents<T extends AgendaOrderItem>(
  items: readonly T[],
): Map<string, string | null> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const parents = new Map<string, string | null>();
  for (const item of items) {
    let parentId =
      item.parentId && byId.has(item.parentId) ? item.parentId : null;
    // Walk up the chain: a cycle would make the item unreachable from a root.
    const seen = new Set<string>([item.id]);
    let cursor = parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        parentId = null;
        break;
      }
      seen.add(cursor);
      const next = byId.get(cursor)?.parentId ?? null;
      cursor = next && byId.has(next) ? next : null;
    }
    parents.set(item.id, parentId);
  }
  return parents;
}

/** Children of every parent id (null = root items), in display order. */
export function agendaChildGroups<T extends AgendaOrderItem>(
  items: readonly T[],
): Map<string | null, T[]> {
  const parents = agendaEffectiveParents(items);
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const parentId = parents.get(item.id) ?? null;
    const group = groups.get(parentId);
    if (group) group.push(item);
    else groups.set(parentId, [item]);
  }
  for (const group of groups.values()) group.sort(compareAgendaSiblings);
  return groups;
}

/**
 * The number of every item, or null for one that has none. Siblings are
 * counted in display order, skipping the unlisted ones, so the listed items
 * read 1, 2, 3 without gaps whoever looks. An unlisted item has no number,
 * and neither has anything under an item without one.
 */
export function numberAgendaItems<T extends AgendaOrderItem>(
  items: readonly T[],
): Map<string, string | null> {
  const groups = agendaChildGroups(items);
  const numbers = new Map<string, string | null>();
  const visit = (parentId: string | null, prefix: string | null) => {
    let listed = 0;
    for (const item of groups.get(parentId) ?? []) {
      let number: string | null = null;
      // `prefix` null below the root level: the parent has no number.
      if (item.unlisted !== true && (parentId === null || prefix !== null)) {
        listed += 1;
        number = prefix === null ? String(listed) : `${prefix}.${listed}`;
      }
      numbers.set(item.id, number);
      visit(item.id, number);
    }
  };
  visit(null, null);
  return numbers;
}

/**
 * The items a plain attendee does not receive, out of the ones a viewer
 * does: what visibleAgendaItems leaves out for someone who sees only the
 * public documents and manages nothing. `publicDocuments` are the documents
 * everyone reads (isPublicDocumentStatus). An item that attendee gets
 * without its title is listed.
 */
export function unlistedAgendaItemIds<
  T extends TitleSource & { id: string; parentId: string | null },
>(
  items: readonly T[],
  publicDocuments: readonly { id: string; agendaItemId: string }[],
): Set<string> {
  const listed = new Set(
    visibleAgendaItems(items, publicDocuments).map((item) => item.id),
  );
  return new Set(
    items.filter((item) => !listed.has(item.id)).map((item) => item.id),
  );
}
