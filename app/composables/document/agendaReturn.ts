/**
 * The way back for a document added from the home page or the agenda.
 * Adding a document opens its editor with `?desde=inicio` or
 * `?desde=orden-del-dia`; the editor then leads back there, and after
 * publishing (or saving) the Secretaría either returns or goes on with
 * "… y añadir otro", which comes back with `?nuevo=<item>` so the page opens
 * the new-document modal on the item after that one.
 */

/** Where a document was added from. */
export type AddOrigin = "agenda" | "home";

/** Query key the editor receives, and its value for each origin. */
export const FROM_QUERY = "desde";
const ORIGIN_VALUES: Record<AddOrigin, string> = {
  agenda: "orden-del-dia",
  home: "inicio",
};

/** Query key that opens the agenda in organize mode. */
export const ORGANIZE_QUERY = "organizar";

/** Query key that opens the new-document modal after the given item. */
export const ADD_AFTER_QUERY = "nuevo";

/** DOM id of an agenda item's heading (focus target and anchor). */
export function agendaItemAnchor(id: string): string {
  return `agenda-item-${id}`;
}

/** The page of one agenda item or sub-item, keyed by its id. */
export function agendaItemPath(hubPath: string, itemId: string): string {
  return `${hubPath}/orden-del-dia/${encodeURIComponent(itemId)}`;
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Where the editor was opened from, read from its query. */
export function originOf(query: Record<string, unknown>): AddOrigin | null {
  const value = firstValue(query[FROM_QUERY]);
  const origin = (Object.keys(ORIGIN_VALUES) as AddOrigin[]).find(
    (key) => ORIGIN_VALUES[key] === value,
  );
  return origin ?? null;
}

/** The item id after which to open the new-document modal, if asked. */
export function addAfterOf(query: Record<string, unknown>): string | null {
  const value = firstValue(query[ADD_AFTER_QUERY]);
  return typeof value === "string" && value ? value : null;
}

/** The editor of a document, remembering where it was added from. */
export function editorFrom(documentPath: string, origin: AddOrigin): string {
  return `${documentPath}/editar?${FROM_QUERY}=${ORIGIN_VALUES[origin]}`;
}

/**
 * The page a document was added from. The agenda comes back organized (for
 * whoever may organize it) and at the item.
 */
export function originPath(
  origin: AddOrigin,
  hubPath: string,
  itemId: string,
): string {
  if (origin === "home") return hubPath;
  return `${hubPath}/orden-del-dia?${ORGANIZE_QUERY}=1#${agendaItemAnchor(itemId)}`;
}

/** The same page with the new-document modal open on the next item. */
export function addAnotherPath(
  origin: AddOrigin,
  hubPath: string,
  itemId: string,
): string {
  const page = origin === "home" ? hubPath : `${hubPath}/orden-del-dia`;
  return `${page}?${ADD_AFTER_QUERY}=${encodeURIComponent(itemId)}`;
}

/**
 * The item to add the next document to, after `itemId` in agenda order among
 * `items` (the ones the user may add to): the next one without documents
 * yet, going round to the start, or else simply the next one.
 */
export function nextItemId(
  items: { id: string; hasDocuments: boolean }[],
  itemId: string,
): string | null {
  if (items.length === 0) return null;
  const start = items.findIndex((item) => item.id === itemId) + 1;
  const ordered = [...items.slice(start), ...items.slice(0, start)];
  const empty = ordered.find(
    (item) => !item.hasDocuments && item.id !== itemId,
  );
  return (empty ?? ordered[0])?.id ?? null;
}
