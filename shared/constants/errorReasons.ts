/**
 * The catalog of refusals (ARQ-1): every code the server sends in
 * `data.reason` of an error (but `empty`, see DOCX_EMPTY_REASON), and every
 * code of the `reasons[]` list of a 422 (validateOps, and
 * `inconsistent_counts`). The client branches only on these:
 * `errorPayload` in `app/composables/api/useApi.ts` reads them and
 * `notifyError` words them. A refusal's `message` is a diagnostic for
 * whoever reads the logs, never shown; `data.messageKey` stays for error
 * pages and the global barriers (`auth.identityChanged`,
 * `common.errors.sessionNotOpen`).
 *
 * A new code enters `ERROR_REASONS` (snake_case, with its domain as prefix)
 * and `fail` (`server/utils/core/http.ts`) refuses any other: its `data` is
 * typed with `ErrorReason`.
 */

// Stale writes -----------------------------------------------------------------

/**
 * A write refused because the row changed since the client read it
 * (`server/utils/optimisticLock.ts`): «Alguien ha modificado estos datos…».
 */
export const STALE_WRITE_REASON = "stale_write";

// Calendar rules of documents (server/utils/domain/documentRefusals.ts) --------

/** The assembly is closed: nothing in it changes any more. */
export const ASSEMBLY_CLOSED_REASON = "assembly_closed";

/**
 * A member creates or sends a document, or changes its kind, past its
 * kind's deadline (presentationDeadlinePassed, `presentationClosed`); only
 * the Secretaría may present it late.
 */
export const DOCUMENTS_DEADLINE_PASSED_REASON = "documents_deadline_passed";

// Executive members (server/utils/domain/executiveMembers.ts) ------------------

/** The 422 that refuses an executive area in a body. */
export const EXECUTIVE_MEMBER_REFUSED_REASON = "executive_member";

/**
 * The 422 for the generic id as main author or main presenter when it
 * cannot say which area: nothing was added, so it has its own wording.
 */
export const EXECUTIVE_MAIN_REFUSED_REASON = "executive_main";

/**
 * The 422 for the generic id in the body of an amendment or a
 * transactional: there every office is named by its real id, so the generic
 * id is never an author.
 */
export const EXECUTIVE_AUTHOR_REFUSED_REASON = "executive_author";

// Control sheet (server/utils/domain/controlSheet.ts) --------------------------

/**
 * The 409 of a sheet field someone else changed since it was read; `data`
 * also carries `fields` and the row as it is now (`row`).
 */
export const CONTROL_SHEET_STALE_REASON = "control_sheet_stale";

/** The 422 an addition to observations already near full gets. */
export const CONTROL_SHEET_OBSERVATIONS_TOO_LONG_REASON =
  "control_sheet_observations_too_long";

/** The 422 a «Retirado» by hand gets on an item with documents. */
export const CONTROL_SHEET_WITHDRAWN_REASON =
  "control_sheet_withdrawn_document";

/**
 * The 422 the Mesa's mark, or a «Retirado» or «Decaído» by hand, gets on an
 * item that still waits for a vote (itemsAwaitingVote): it is treated only
 * by its votes (user's decision of 2026-11-19).
 */
export const CONTROL_SHEET_AWAITING_VOTE_REASON = "control_sheet_awaiting_vote";

/**
 * The 422 the Mesa's mark gets on an amendment still to be decided: it is
 * treated when the Mesa settles it (user's decision of 2026-11-19).
 */
export const CONTROL_SHEET_UNDECIDED_REASON =
  "control_sheet_amendment_undecided";

// Votes on an agenda item (server/utils/domain/itemVotes.ts) -------------------

/** The 422 a vote on an item with voted documents gets. */
export const ITEM_HAS_VOTED_DOCUMENTS_REASON = "item_has_voted_documents";

/**
 * The same refusal, worded for someone who may not see those documents
 * (none of them is public yet), so it names none.
 */
export const ITEM_TAKES_NO_VOTE_REASON = "item_takes_no_vote";

/** The 422 for an item where members present. */
export const ITEM_IS_CONTAINER_REASON = "item_is_container";

// Seating (server/utils/domain/seating.ts) -------------------------------------

/** The room changed under a write; `data` carries the room as it is now. */
export const SEATING_STALE_REASON = "seating_stale";

/** A layout save that removes occupied seats, until the client confirms it. */
export const SEATING_SEATS_OCCUPIED_REASON = "seating_seats_occupied";

/** A group, a person or a whole room that is no longer there (or an AGET). */
export const SEATING_NOT_FOUND_REASON = "seating_not_found";

// Agenda (shared/utils/agendaSubmissions.ts, shared/utils/schemas/assembly.ts) -

/** The 422 a member gets for a kind the item refuses. */
export const SUBMISSION_KIND_REFUSED_REASON = "submission_kind";

/** The 422 for putting a document in the automatic sub-item of another one. */
export const AUTO_ITEM_REFUSED_REASON = "auto_item";

/**
 * The 409 a delete of an agenda item gets while a document under it has
 * amendments. `data` also carries `documents` (how many documents have any)
 * and `amendments` (how many rows in all).
 */
export const AGENDA_DELETE_AMENDMENTS_REASON = "agenda_item_amendments";

/**
 * The 409 a delete of an agenda item gets during the session while the
 * item, a sub-item or one of their documents is being projected, or one of
 * them has speaking turns still open.
 */
export const AGENDA_DELETE_LIVE_REASON = "agenda_item_live";

/**
 * The 409 a delete of an agenda item gets while the control sheet noted
 * something about it or a sub-item (a listing, a result by hand, a treated
 * mark or observations): the record of the session is never deleted along
 * with the agenda.
 */
export const AGENDA_DELETE_SHEET_REASON = "agenda_item_sheet";

/**
 * The 409 a change to the root items gets once the agenda is final and the
 * request does not say `confirmFinal: true`. The client asks and sends the
 * request again with it.
 */
export const AGENDA_FINAL_CONFLICT_REASON = "agenda_final";

// Documents ----------------------------------------------------------------------

/** The 422 of a PDF for a type that takes amendments (documentFormat.ts). */
export const FILE_FORMAT_REFUSED_REASON = "file_kind";

/**
 * A DOCX with no text the import reads (blank, or text only in images,
 * headers or shapes). It shares its 422 with «too extensive», so the client
 * tells the member that splitting the file cannot help. Until the release
 * after ARQ-1 the server sends it as `empty`, its code before
 * (`emptyDocumentError` in `server/utils/content/docx.ts`), which
 * `errorPayload` reads as this one.
 */
export const DOCX_EMPTY_REASON = "docx_empty";

// Approved text: corrections of form and conciliations (formCorrections.ts) ---

/**
 * A proposed correction whose text another correction changed since it was
 * proposed: it is corrected directly with what it proposed.
 */
export const FORM_CORRECTION_STALE_REASON = "form_correction_stale";

/** A correction of form while a passage is pending conciliation. */
export const FORM_CORRECTION_PENDING_CONCILIATION_REASON =
  "form_correction_pending_conciliation";

/** A correction of form that changes nothing. */
export const FORM_CORRECTION_NO_CHANGE_REASON = "form_correction_no_change";

/** The passage is no longer pending (or no longer the same). */
export const PASSAGE_CHANGED_REASON = "passage_changed";

/** A passage's wording that changes text outside the passage. */
export const WORDING_OUTSIDE_REASON = "wording_outside";

/** A presenter that is not a member of a kind that may present it. */
export const PRESENTER_KIND_REASON = "presenter_kind";

/** A change of presenters only the main presenter may make (403). */
export const PRESENTERS_MAIN_ONLY_REASON = "main_only";

// Members, the session -----------------------------------------------------------

/**
 * A sync of the roster that would deactivate too many members, until it is
 * confirmed; `data` also carries `kinds` (MemberSyncBlockedData).
 */
export const LARGE_DEACTIVATION_REASON = "large_deactivation";

/** Another console controls the projection: its `messageKey` words it. */
export const PROJECTION_CONTROL_REASON = "projection_control";

/**
 * The 422 of a roll call whose ballots do not match the latest headcount (a
 * delegation that is not a voter, one that votes twice, or a choice the
 * vote does not take): the form only offers the headcount's voters, so it
 * happens only when that headcount changed meanwhile.
 */
export const ROLL_CALL_MISMATCH_REASON = "roll_call_mismatch";

/**
 * Every code of `data.reason`, and the i18n key `notifyError` words it with.
 * `null`: the form that causes it words it itself (or the interface keeps it
 * from happening), and `notifyError` falls back to the status. Giving one a
 * key is a wording decision: a 409 with a key no longer reads the neutral
 * `common.errors.conflictState`.
 */
export const ERROR_REASONS = {
  [STALE_WRITE_REASON]: "common.errors.conflict",
  [ASSEMBLY_CLOSED_REASON]: "common.errors.assemblyClosed",
  [DOCUMENTS_DEADLINE_PASSED_REASON]: "common.errors.documentsDeadlinePassed",
  [EXECUTIVE_MEMBER_REFUSED_REASON]: "common.errors.executiveMember",
  [EXECUTIVE_MAIN_REFUSED_REASON]: "common.errors.executiveMain",
  [EXECUTIVE_AUTHOR_REFUSED_REASON]: "common.errors.executiveAuthor",
  [CONTROL_SHEET_STALE_REASON]: "common.errors.controlSheetStale",
  [CONTROL_SHEET_OBSERVATIONS_TOO_LONG_REASON]: null,
  [CONTROL_SHEET_WITHDRAWN_REASON]: "common.errors.controlSheetWithdrawn",
  [CONTROL_SHEET_AWAITING_VOTE_REASON]:
    "common.errors.controlSheetAwaitingVote",
  [CONTROL_SHEET_UNDECIDED_REASON]: "common.errors.controlSheetUndecided",
  [ITEM_HAS_VOTED_DOCUMENTS_REASON]: "common.errors.itemHasVotedDocuments",
  [ITEM_TAKES_NO_VOTE_REASON]: "common.errors.itemTakesNoVote",
  [ITEM_IS_CONTAINER_REASON]: "common.errors.itemIsContainer",
  [SEATING_STALE_REASON]: "common.errors.seatingStale",
  [SEATING_SEATS_OCCUPIED_REASON]: "common.errors.seatingSeatsOccupied",
  [SEATING_NOT_FOUND_REASON]: "common.errors.seatingNotFound",
  [SUBMISSION_KIND_REFUSED_REASON]: null,
  [AUTO_ITEM_REFUSED_REASON]: null,
  [AGENDA_DELETE_AMENDMENTS_REASON]: null,
  [AGENDA_DELETE_LIVE_REASON]: null,
  [AGENDA_DELETE_SHEET_REASON]: null,
  [AGENDA_FINAL_CONFLICT_REASON]: null,
  [FILE_FORMAT_REFUSED_REASON]: null,
  [DOCX_EMPTY_REASON]: null,
  [FORM_CORRECTION_STALE_REASON]: null,
  [FORM_CORRECTION_PENDING_CONCILIATION_REASON]: null,
  [FORM_CORRECTION_NO_CHANGE_REASON]: null,
  [PASSAGE_CHANGED_REASON]: null,
  [WORDING_OUTSIDE_REASON]: null,
  [PRESENTER_KIND_REASON]: null,
  [PRESENTERS_MAIN_ONLY_REASON]: null,
  [LARGE_DEACTIVATION_REASON]: null,
  [PROJECTION_CONTROL_REASON]: null,
  [ROLL_CALL_MISMATCH_REASON]: null,
} as const satisfies Record<string, string | null>;

/** A code of `data.reason`. */
export type ErrorReason = keyof typeof ERROR_REASONS;

/** Whether a value is a code of the catalog. */
export function isErrorReason(value: unknown): value is ErrorReason {
  return typeof value === "string" && Object.hasOwn(ERROR_REASONS, value);
}

/** The i18n key of a code of `data.reason`, or null when it has none. */
export function errorReasonMessageKey(reason: ErrorReason): string | null {
  return ERROR_REASONS[reason];
}

/**
 * The codes of the `reasons[]` list (`{ index, reason }`) of a 422: the
 * problems validateOps finds (shared/utils/content/ops.ts), and
 * `inconsistent_counts` for vote counts that do not add up. Each reads
 * `amendment.errors.<code>`; a single refusal of any other kind carries
 * `data.reason` instead.
 */
export const LISTED_ERROR_REASONS = [
  "empty",
  "delete_empty",
  "unknown_block",
  "duplicate_delete",
  "unknown_anchor",
  "duplicate_anchor",
  "insert_empty",
  "duplicate_block_id",
  "out_of_range",
  "anchor_mismatch",
  "noop",
  "replace_in_deleted_block",
  "overlapping_ops",
  "inconsistent_counts",
  "format_shape",
  "format_image",
  "duplicate_format",
  "marks_out_of_range",
] as const;

/** A code of the `reasons[]` list. */
export type ListedErrorReason = (typeof LISTED_ERROR_REASONS)[number];

/** Whether a value is a code of the `reasons[]` list. */
export function isListedErrorReason(
  value: unknown,
): value is ListedErrorReason {
  return (
    typeof value === "string" &&
    (LISTED_ERROR_REASONS as readonly string[]).includes(value)
  );
}

/** The i18n key of a code of the `reasons[]` list. */
export function listedErrorReasonMessageKey(reason: ListedErrorReason): string {
  return `amendment.errors.${reason}`;
}

/**
 * The two lists never share a code: a client that reads `reason` and
 * `reasons[]` with one switch would mistake one for the other.
 */
type SharedCodes = Extract<ErrorReason, ListedErrorReason>;
const noSharedCodes: [SharedCodes] extends [never] ? true : never = true;
void noSharedCodes;
