/**
 * `data.reason` of the document 409s that are calendar rules, not a stale
 * read. useApi's REASON_KEYS words each one, so the page does not show the
 * optimistic lock's «Alguien ha modificado estos datos».
 */

/** The assembly is closed: nothing in it changes any more. */
export const ASSEMBLY_CLOSED_REASON = "assembly_closed";

/**
 * A member creates or sends a document past `documents_close`
 * (`presentationClosed`); only the Secretaría may present it late.
 */
export const DOCUMENTS_DEADLINE_PASSED_REASON = "documents_deadline_passed";
