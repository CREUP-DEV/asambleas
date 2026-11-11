/**
 * Agenda tree helpers. The API returns agenda items flat (`parentId` +
 * `order`); the client builds the tree, numbers it hierarchically ("1",
 * "1.1", "1.1.2") and computes the reorder payloads for keyboard moves.
 * The numbers are the shared rule's (numberAgendaItems), the same for every
 * viewer and for the PDFs: an item not everyone receives yet (`unlisted`)
 * has none.
 *
 * It also holds the folding state of the tree, the rule that shows an item
 * and its only document in one row, and what a final agenda asks to confirm.
 *
 * Every function is pure and never mutates its input.
 */

import {
  agendaChildGroups,
  agendaEffectiveParents,
  numberAgendaItems,
} from "~~/shared/utils/agendaNumbering";
import { AGENDA_FINAL_CONFLICT_CODE } from "~~/shared/utils/schemas/assembly";
import { titleFromItemTitle } from "~/composables/document/itemProposal";

export interface AgendaTreeItem {
  id: string;
  parentId: string | null;
  order: number;
  /** Not everyone receives the item yet: it has no number. */
  unlisted?: boolean;
}

export interface AgendaTreeNode<T extends AgendaTreeItem = AgendaTreeItem> {
  item: T;
  /**
   * Hierarchical number: "1", "1.2", "1.2.3". Null for an item that is not
   * in the agenda for everyone yet (`unlisted`), and for anything under one.
   */
  number: string | null;
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

const effectiveParents = agendaEffectiveParents;
const groupChildren = agendaChildGroups;

/**
 * Builds the agenda tree from the flat list. Items whose parent is missing
 * (or that form a cycle) are shown as root items rather than dropped.
 */
export function buildAgendaTree<T extends AgendaTreeItem>(
  items: readonly T[],
): AgendaTreeNode<T>[] {
  const groups = groupChildren(items);
  const numbers = numberAgendaItems(items);

  const build = (
    parentId: string | null,
    depth: number,
  ): AgendaTreeNode<T>[] => {
    const siblings = groups.get(parentId) ?? [];
    return siblings.map((item, index) => ({
      item,
      number: numbers.get(item.id) ?? null,
      depth,
      index,
      siblingCount: siblings.length,
      parentId,
      children: build(item.id, depth + 1),
    }));
  };

  return build(null, 0);
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

/** Hierarchical number of every item id; null for one that has none. */
export function agendaNumbers<T extends AgendaTreeItem>(
  items: readonly T[],
): Map<string, string | null> {
  return numberAgendaItems(items);
}

/**
 * An item with its number in running text: "3. Resoluciones". One without a
 * number (not in the agenda for everyone yet) reads as its title followed by
 * `unlistedMark`, the words that say so ("(sin publicar)").
 */
export function numberedAgendaTitle(
  number: string | null | undefined,
  title: string,
  unlistedMark: string,
): string {
  return number ? `${number}. ${title}` : `${title} ${unlistedMark}`;
}

/**
 * What stands for the number inside a sentence about an item ("Subir el
 * punto 3: ..."): the number, or `unlistedMark` for an item without one, so
 * a label never reads an empty number.
 */
export function agendaNumberInText(
  number: string | null | undefined,
  unlistedMark: string,
): string {
  return number || unlistedMark;
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

/** The ids above an item, nearest first: its parent, its parent's parent... */
export function agendaAncestorIds<T extends AgendaTreeItem>(
  items: readonly T[],
  id: string,
): string[] {
  const parents = effectiveParents(items);
  const result: string[] = [];
  let cursor = parents.get(id) ?? null;
  while (cursor && !result.includes(cursor)) {
    result.push(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return result;
}

// The page of one item ---------------------------------------------------------

/** The node of an item anywhere in the tree, or null. */
export function findAgendaNode<T extends AgendaTreeItem>(
  tree: readonly AgendaTreeNode<T>[],
  id: string,
): AgendaTreeNode<T> | null {
  return flattenAgendaTree(tree).find((node) => node.item.id === id) ?? null;
}

/**
 * The nodes from the root item down to the given one, itself last. Empty
 * when the item is not in the tree.
 */
export function agendaNodePath<T extends AgendaTreeItem>(
  tree: readonly AgendaTreeNode<T>[],
  id: string,
): AgendaTreeNode<T>[] {
  const byId = new Map(
    flattenAgendaTree(tree).map((node) => [node.item.id, node]),
  );
  const path: AgendaTreeNode<T>[] = [];
  let cursor = byId.get(id);
  while (cursor && !path.includes(cursor)) {
    path.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path;
}

/**
 * The items before and after one in reading order (1, 1.1, 1.2, 2...),
 * whatever their level: what "Anterior" and "Siguiente" open.
 */
export function agendaNeighbours<T extends AgendaTreeItem>(
  tree: readonly AgendaTreeNode<T>[],
  id: string,
): { previous: AgendaTreeNode<T> | null; next: AgendaTreeNode<T> | null } {
  const flat = flattenAgendaTree(tree);
  const index = flat.findIndex((node) => node.item.id === id);
  if (index < 0) return { previous: null, next: null };
  return {
    previous: flat[index - 1] ?? null,
    next: flat[index + 1] ?? null,
  };
}

export interface AgendaItemTotals {
  documents: number;
  amendments: number;
}

/**
 * Documents and amendments of every item, counting those of its sub-items
 * at any depth.
 */
export function agendaSubtreeTotals<T extends AgendaTreeItem>(
  items: readonly T[],
  documents: readonly { agendaItemId: string; amendmentCount: number }[],
): Map<string, AgendaItemTotals> {
  const own = new Map<string, AgendaItemTotals>();
  for (const document of documents) {
    const entry = own.get(document.agendaItemId) ?? {
      documents: 0,
      amendments: 0,
    };
    entry.documents += 1;
    entry.amendments += document.amendmentCount;
    own.set(document.agendaItemId, entry);
  }
  const totals = new Map<string, AgendaItemTotals>();
  const visit = (node: AgendaTreeNode<T>): AgendaItemTotals => {
    const total = {
      ...(own.get(node.item.id) ?? { documents: 0, amendments: 0 }),
    };
    for (const child of node.children) {
      const sub = visit(child);
      total.documents += sub.documents;
      total.amendments += sub.amendments;
    }
    totals.set(node.item.id, total);
    return total;
  };
  for (const root of buildAgendaTree(items)) visit(root);
  return totals;
}

/**
 * The documents in reading order: item by item as the agenda reads (1, 1.1,
 * 1.2, 2...), and within an item as they are listed. What "Anterior" and
 * "Siguiente" walk on a document's page. A document of an item that is not
 * in the tree is left out.
 */
export function documentsInAgendaOrder<
  T extends AgendaTreeItem,
  D extends { agendaItemId: string },
>(tree: readonly AgendaTreeNode<T>[], documents: readonly D[]): D[] {
  const byItem = new Map<string, D[]>();
  for (const document of documents) {
    const list = byItem.get(document.agendaItemId);
    if (list) list.push(document);
    else byItem.set(document.agendaItemId, [document]);
  }
  return flattenAgendaTree(tree).flatMap(
    (node) => byItem.get(node.item.id) ?? [],
  );
}

/**
 * How many documents and amendments are left to read under every item,
 * counting its sub-items at any depth. `left` says it of one document.
 */
export function agendaSubtreeLeft<T extends AgendaTreeItem>(
  tree: readonly AgendaTreeNode<T>[],
  documents: readonly { id: string; agendaItemId: string }[],
  left: (documentId: string) => number,
): Map<string, number> {
  const own = new Map<string, number>();
  for (const document of documents) {
    own.set(
      document.agendaItemId,
      (own.get(document.agendaItemId) ?? 0) + left(document.id),
    );
  }
  const totals = new Map<string, number>();
  const visit = (node: AgendaTreeNode<T>): number => {
    let total = own.get(node.item.id) ?? 0;
    for (const child of node.children) total += visit(child);
    totals.set(node.item.id, total);
    return total;
  };
  for (const root of tree) visit(root);
  return totals;
}

// Folding -------------------------------------------------------------------

/**
 * What the reader folded or unfolded by hand, on top of the default state.
 * Only this is stored (per assembly, in the browser), so items added later
 * still get the default.
 */
export interface AgendaFoldState {
  /** Items unfolded by hand. */
  open: string[];
  /** Items folded by hand. */
  closed: string[];
}

export const EMPTY_AGENDA_FOLD: AgendaFoldState = { open: [], closed: [] };

/** The stored fold state, or the empty one when it is missing or damaged. */
export function readAgendaFold(value: unknown): AgendaFoldState {
  if (!value || typeof value !== "object") return EMPTY_AGENDA_FOLD;
  const { open, closed } = value as { open?: unknown; closed?: unknown };
  const ids = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string")
      : [];
  return { open: ids(open), closed: ids(closed) };
}

/** The items that can fold: the ones with sub-items. */
export function agendaFoldableIds<T extends AgendaTreeItem>(
  items: readonly T[],
): string[] {
  return flattenAgendaTree(buildAgendaTree(items))
    .filter((node) => node.children.length > 0)
    .map((node) => node.item.id);
}

/**
 * Folded by default: every item below the root level that has sub-items. So
 * the sub-items of a root item show, and theirs stay hidden until opened.
 */
export function defaultCollapsedIds<T extends AgendaTreeItem>(
  items: readonly T[],
): Set<string> {
  return new Set(
    flattenAgendaTree(buildAgendaTree(items))
      .filter((node) => node.depth >= 1 && node.children.length > 0)
      .map((node) => node.item.id),
  );
}

/** The folded items: the default ones, with what the reader changed. */
export function collapsedAgendaIds<T extends AgendaTreeItem>(
  items: readonly T[],
  state: AgendaFoldState,
): Set<string> {
  const foldable = new Set(agendaFoldableIds(items));
  const collapsed = defaultCollapsedIds(items);
  for (const id of state.closed) if (foldable.has(id)) collapsed.add(id);
  for (const id of state.open) collapsed.delete(id);
  return collapsed;
}

/** Folds an unfolded item, or unfolds a folded one. */
export function toggleAgendaFold<T extends AgendaTreeItem>(
  items: readonly T[],
  state: AgendaFoldState,
  id: string,
): AgendaFoldState {
  const folded = collapsedAgendaIds(items, state).has(id);
  const open = state.open.filter((entry) => entry !== id);
  const closed = state.closed.filter((entry) => entry !== id);
  if (folded) open.push(id);
  else closed.push(id);
  return { open, closed };
}

/** Unfolds everything above an item, so the item itself shows. */
export function expandAgendaAncestors<T extends AgendaTreeItem>(
  items: readonly T[],
  state: AgendaFoldState,
  id: string,
): AgendaFoldState {
  const collapsed = collapsedAgendaIds(items, state);
  const hidden = agendaAncestorIds(items, id).filter((ancestor) =>
    collapsed.has(ancestor),
  );
  if (hidden.length === 0) return state;
  return {
    open: [...state.open, ...hidden.filter((a) => !state.open.includes(a))],
    closed: state.closed.filter((entry) => !hidden.includes(entry)),
  };
}

/** "Desplegar todo": every item with sub-items unfolded. */
export function expandAllAgenda<T extends AgendaTreeItem>(
  items: readonly T[],
): AgendaFoldState {
  return { open: agendaFoldableIds(items), closed: [] };
}

/** "Plegar todo": every item with sub-items folded, root items included. */
export function collapseAllAgenda<T extends AgendaTreeItem>(
  items: readonly T[],
): AgendaFoldState {
  return { open: [], closed: agendaFoldableIds(items) };
}

// Item and document with the same name ----------------------------------------

function comparableTitle(value: string): string {
  return value
    .trim()
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es");
}

/**
 * Whether an item and a document are called the same: ignoring case, outer
 * spaces and a final full stop, and also when the item is the approval of
 * the document ("Aprobación, si procede, del Reglamento" and "Reglamento").
 */
export function sameAgendaTitle(
  itemTitle: string,
  documentTitle: string,
): boolean {
  const document = comparableTitle(documentTitle);
  if (!document) return false;
  if (comparableTitle(itemTitle) === document) return true;
  const proposed = titleFromItemTitle(itemTitle);
  return proposed !== null && comparableTitle(proposed) === document;
}

/**
 * The document an item shows in its own row instead of a row below: its
 * only document, when both are called the same. Null otherwise.
 */
export function mergedAgendaDocument<D extends { title: string }>(
  itemTitle: string,
  documents: readonly D[],
): D | null {
  const [only] = documents;
  return documents.length === 1 &&
    only &&
    sameAgendaTitle(itemTitle, only.title)
    ? only
    : null;
}

// Final agenda ----------------------------------------------------------------

function rootOrder<T extends AgendaTreeItem>(items: readonly T[]): string {
  return (groupChildren(items).get(null) ?? [])
    .map((item) => item.id)
    .join(",");
}

/**
 * Whether a reorder changes which items are root items or their order. Once
 * the agenda is final the server asks for a confirmation of those.
 */
export function reorderChangesRoots<T extends AgendaTreeItem>(
  items: readonly T[],
  entries: readonly AgendaReorderEntry[],
): boolean {
  return rootOrder(items) !== rootOrder(applyAgendaReorder(items, entries));
}

/**
 * Runs a request that may change the root items of a final agenda. The
 * agenda page provides it: it asks "¿Cambiarlo igualmente?" when
 * `changesRoots` and the agenda is final (or when the server answers 409
 * `agenda_final`), and calls `run` with `confirmFinal` true after a yes.
 * Resolves to null when the user says no.
 */
export type AgendaRootChangeRunner = <T>(
  changesRoots: boolean,
  run: (confirmFinal: boolean) => Promise<T>,
) => Promise<T | null>;

/**
 * Whether a failed request is the server asking to confirm a change to the
 * root items of a final agenda (409 with `data.code`). ofetch keeps the
 * response body in `data`, whose own `data` is what createError got.
 */
export function isAgendaFinalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const body = (error as { data?: unknown }).data;
  if (!body || typeof body !== "object") return false;
  const { code, data } = body as { code?: unknown; data?: unknown };
  const nested =
    data && typeof data === "object"
      ? (data as { code?: unknown }).code
      : undefined;
  return (nested ?? code) === AGENDA_FINAL_CONFLICT_CODE;
}

// Moves -----------------------------------------------------------------------

/** Whether a move is possible. */
export function canMoveAgendaItem<T extends AgendaTreeItem>(
  items: readonly T[],
  id: string,
  move: AgendaMove,
): boolean {
  return planAgendaMove(items, id, move) !== null;
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
): AgendaReorderEntry[] | null {
  const parents = effectiveParents(items);
  if (!parents.has(id)) return null;
  const groups = groupChildren(items);
  const parentId = parents.get(id) ?? null;
  const siblings = [...(groups.get(parentId) ?? [])];
  const index = siblings.findIndex((item) => item.id === id);
  if (index < 0) return null;

  /** Desired layout of each touched group, as ordered ids. */
  const layout = new Map<string | null, string[]>();

  switch (move) {
    case "up":
    case "down": {
      const target = move === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= siblings.length) return null;
      const ids = siblings.map((item) => item.id);
      [ids[index], ids[target]] = [ids[target]!, ids[index]!];
      layout.set(parentId, ids);
      break;
    }
    case "indent": {
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
