/**
 * Agenda tree helpers. The API returns agenda items flat (`parentId` +
 * `order`); the client builds the tree, numbers it hierarchically ("1",
 * "1.1", "1.1.2") and computes the reorder payloads for keyboard moves.
 *
 * Every function is pure and never mutates its input.
 */

export interface AgendaTreeItem {
  id: string;
  parentId: string | null;
  order: number;
}

export interface AgendaTreeNode<T extends AgendaTreeItem = AgendaTreeItem> {
  item: T;
  /** Hierarchical number: "1", "1.2", "1.2.3". */
  number: string;
  /** 0 for root items. */
  depth: number;
  /** Position among its siblings, from 0. */
  index: number;
  /** Number of siblings, itself included. */
  siblingCount: number;
  parentId: string | null;
  children: AgendaTreeNode<T>[];
}

export type AgendaMove = "up" | "down" | "indent" | "outdent";

export interface AgendaReorderEntry {
  id: string;
  parentId: string | null;
  order: number;
}

function compareSiblings(a: AgendaTreeItem, b: AgendaTreeItem): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

/**
 * Effective parent of every item: the declared one, or null (root) when the
 * parent is missing or the declared chain loops back on itself.
 */
function effectiveParents<T extends AgendaTreeItem>(
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

/** Children of every parent id (null = root items), sorted by `order`. */
function groupChildren<T extends AgendaTreeItem>(
  items: readonly T[],
): Map<string | null, T[]> {
  const parents = effectiveParents(items);
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const parentId = parents.get(item.id) ?? null;
    const group = groups.get(parentId);
    if (group) group.push(item);
    else groups.set(parentId, [item]);
  }
  for (const group of groups.values()) group.sort(compareSiblings);
  return groups;
}

/**
 * Builds the agenda tree from the flat list. Items whose parent is missing
 * (or that form a cycle) are shown as root items rather than dropped.
 */
export function buildAgendaTree<T extends AgendaTreeItem>(
  items: readonly T[],
): AgendaTreeNode<T>[] {
  const groups = groupChildren(items);

  const build = (
    parentId: string | null,
    prefix: string,
    depth: number,
  ): AgendaTreeNode<T>[] => {
    const siblings = groups.get(parentId) ?? [];
    return siblings.map((item, index) => {
      const number = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      return {
        item,
        number,
        depth,
        index,
        siblingCount: siblings.length,
        parentId,
        children: build(item.id, number, depth + 1),
      };
    });
  };

  return build(null, "", 0);
}

/** The tree in reading order (pre-order): 1, 1.1, 1.2, 2... */
export function flattenAgendaTree<T extends AgendaTreeItem>(
  tree: readonly AgendaTreeNode<T>[],
): AgendaTreeNode<T>[] {
  const result: AgendaTreeNode<T>[] = [];
  const visit = (nodes: readonly AgendaTreeNode<T>[]) => {
    for (const node of nodes) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(tree);
  return result;
}

/** Hierarchical number of every item id. */
export function agendaNumbers<T extends AgendaTreeItem>(
  items: readonly T[],
): Map<string, string> {
  return new Map(
    flattenAgendaTree(buildAgendaTree(items)).map((node) => [
      node.item.id,
      node.number,
    ]),
  );
}

/** The ids of an item and all its descendants. */
export function agendaSubtreeIds<T extends AgendaTreeItem>(
  items: readonly T[],
  id: string,
): Set<string> {
  const groups = groupChildren(items);
  const result = new Set<string>();
  const visit = (current: string) => {
    if (result.has(current)) return;
    result.add(current);
    for (const child of groups.get(current) ?? []) visit(child.id);
  };
  if (items.some((item) => item.id === id)) visit(id);
  return result;
}

/**
 * Whether a move is possible. With `rootsLocked` (final agenda) the sequence
 * of root items cannot change: roots cannot move, be indented, and no item
 * can be outdented to the root level.
 */
export function canMoveAgendaItem<T extends AgendaTreeItem>(
  items: readonly T[],
  id: string,
  move: AgendaMove,
  options: { rootsLocked?: boolean } = {},
): boolean {
  return planAgendaMove(items, id, move, options) !== null;
}

/**
 * The entries to send to PUT /agenda/reorder for a move, or null when the
 * move is impossible. Every sibling group the move touches is renumbered
 * 0..n-1, and only the entries that actually change are returned.
 *
 * - up / down: swap with the previous / next sibling.
 * - indent: become the last child of the previous sibling.
 * - outdent: become the next sibling of the current parent.
 */
export function planAgendaMove<T extends AgendaTreeItem>(
  items: readonly T[],
  id: string,
  move: AgendaMove,
  options: { rootsLocked?: boolean } = {},
): AgendaReorderEntry[] | null {
  const parents = effectiveParents(items);
  if (!parents.has(id)) return null;
  const groups = groupChildren(items);
  const parentId = parents.get(id) ?? null;
  const siblings = [...(groups.get(parentId) ?? [])];
  const index = siblings.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const locked = Boolean(options.rootsLocked);

  /** Desired layout of each touched group, as ordered ids. */
  const layout = new Map<string | null, string[]>();

  switch (move) {
    case "up":
    case "down": {
      if (locked && parentId === null) return null;
      const target = move === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= siblings.length) return null;
      const ids = siblings.map((item) => item.id);
      [ids[index], ids[target]] = [ids[target]!, ids[index]!];
      layout.set(parentId, ids);
      break;
    }
    case "indent": {
      if (locked && parentId === null) return null;
      const newParent = siblings[index - 1];
      if (!newParent) return null;
      layout.set(
        parentId,
        siblings.filter((item) => item.id !== id).map((item) => item.id),
      );
      layout.set(newParent.id, [
        ...(groups.get(newParent.id) ?? []).map((item) => item.id),
        id,
      ]);
      break;
    }
    case "outdent": {
      if (parentId === null) return null;
      const grandParentId = parents.get(parentId) ?? null;
      if (locked && grandParentId === null) return null;
      layout.set(
        parentId,
        siblings.filter((item) => item.id !== id).map((item) => item.id),
      );
      const uncles = (groups.get(grandParentId) ?? []).map((item) => item.id);
      const parentIndex = uncles.indexOf(parentId);
      uncles.splice(parentIndex + 1, 0, id);
      layout.set(grandParentId, uncles);
      break;
    }
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const entries: AgendaReorderEntry[] = [];
  for (const [groupParent, ids] of layout) {
    ids.forEach((itemId, order) => {
      const item = byId.get(itemId);
      if (!item) return;
      if (item.parentId !== groupParent || item.order !== order) {
        entries.push({ id: itemId, parentId: groupParent, order });
      }
    });
  }
  return entries.length > 0 ? entries : null;
}

/** Applies reorder entries locally (optimistic update). */
export function applyAgendaReorder<T extends AgendaTreeItem>(
  items: readonly T[],
  entries: readonly AgendaReorderEntry[],
): T[] {
  const changes = new Map(entries.map((entry) => [entry.id, entry]));
  return items.map((item) => {
    const change = changes.get(item.id);
    return change
      ? { ...item, parentId: change.parentId, order: change.order }
      : item;
  });
}
