/**
 * The events that may send an email (NOTIFYING_EVENT_TYPES): recordEvent
 * queues them in notification_outbox, in the transaction of the change.
 * Which notices they become, and for whom, is decided once committed
 * (planDeliveries in ./plan.ts). Pure: events.ts imports it.
 */
export const NOTIFYING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "document_created",
  "document_updated",
  "document_submitted",
  "document_correction_requested",
  "document_published",
  "document_voted",
  "amendment_submitted",
  "amendment_correction_requested",
  "amendment_validated",
  "amendment_admitted",
  "amendment_inadmissible",
  "amendment_approved",
  "amendment_rejected",
  "amendment_lapsed",
  "amendment_transacted",
  "amendment_withdrawn",
  "amendment_reclassified",
  "amendment_authors_changed",
  "acceptance_recorded",
]);

/** The changes of a document that tell its presenters something. */
export const NOTIFYING_DOCUMENT_CHANGES = [
  "proponentMemberId",
  "coProponentMemberIds",
  "dueAt",
] as const;

/**
 * Whether an event goes to the outbox. A document update does only when
 * it changes who presents it or its internal deadline, and an acceptance
 * only when it accepts: everything else would be read and dropped.
 */
export function eventMayNotify(
  type: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (!NOTIFYING_EVENT_TYPES.has(type)) return false;
  if (type === "document_updated") {
    const changes = payload?.changes;
    if (!changes || typeof changes !== "object") return false;
    return NOTIFYING_DOCUMENT_CHANGES.some((key) => key in changes);
  }
  if (type === "acceptance_recorded") {
    return payload?.decision === "accepted";
  }
  return true;
}
