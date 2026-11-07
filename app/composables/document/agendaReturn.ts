/**
 * The way back to the agenda for a document opened from it. Adding a
 * document under an item opens its editor with `?desde=orden-del-dia`; the
 * editor then offers "Volver al orden del día" and, once the Secretaría
 * publishes or deletes it, goes straight back to that item with the agenda
 * still organized, where "Añadir documento" waits for the next one.
 */

/** DOM id of an agenda item's heading (focus target and anchor). */
export function agendaItemAnchor(id: string): string {
  return `agenda-item-${id}`;
}

/** Query key and value the editor receives when opened from the agenda. */
export const FROM_QUERY = "desde";
export const FROM_AGENDA = "orden-del-dia";

/** Query key that opens the agenda in organize mode. */
export const ORGANIZE_QUERY = "organizar";

/** Whether a route query says the page was opened from the agenda. */
export function cameFromAgenda(query: Record<string, unknown>): boolean {
  const value = query[FROM_QUERY];
  return (Array.isArray(value) ? value[0] : value) === FROM_AGENDA;
}

/** The editor of a document, remembering that it was opened from the agenda. */
export function editorFromAgenda(documentPath: string): string {
  return `${documentPath}/editar?${FROM_QUERY}=${FROM_AGENDA}`;
}

/**
 * The agenda at an item: organized (for whoever may organize it) and
 * scrolled to the item.
 */
export function agendaAtItem(agendaPath: string, itemId: string): string {
  return `${agendaPath}?${ORGANIZE_QUERY}=1#${agendaItemAnchor(itemId)}`;
}
