import type { AmendmentDto, LiveStateDto } from "~~/shared/types/api";
import type { LiveBlocPurpose } from "~~/shared/constants/domain";
import { isLiveAdmissionProposable, sameBloc } from "~~/shared/utils/liveBloc";
import {
  isSessionPendingAdmission,
  sortSessionAmendments,
  type SessionAdmissionDecision,
} from "./sessionModel";

/**
 * The bloc on screen is one pointer with a purpose (user's decision of
 * 2026-11-21): approving its amendments (no purpose), or admitting late
 * ones to debate or not. The console reads each through its own helper, so
 * a proposal on admission never feeds the approval paths: once the Mesa
 * admits it by assent its amendments are open, and «Aprobar» on a bloc
 * still on screen would approve them all (the 80.ª AGO's 2026-11-20 bug,
 * the other way round).
 */
type LivePointerView = Pick<
  LiveStateDto,
  "documentId" | "amendmentBloc" | "amendmentBlocPurpose"
>;

/**
 * The bloc on screen proposed for approval, for the document the console
 * shows; empty without one, for another document or for a proposal on
 * admission.
 */
export function sessionApprovalBloc(
  state: LivePointerView | null | undefined,
  documentId: string | null | undefined,
): string[] {
  if (!state || !documentId || state.documentId !== documentId) return [];
  // A server not updated yet sends no purpose: a plain bloc.
  if (state.amendmentBlocPurpose) return [];
  return state.amendmentBloc ?? [];
}

/** A proposal on admission on screen: its amendments and what it proposes. */
export interface SessionAdmissionProposal {
  ids: string[];
  purpose: LiveBlocPurpose;
}

/**
 * The proposal on admission on screen for the document the console shows;
 * null without one, for another document or for a bloc to approve.
 */
export function sessionAdmissionProposal(
  state: LivePointerView | null | undefined,
  documentId: string | null | undefined,
): SessionAdmissionProposal | null {
  if (!state || !documentId || state.documentId !== documentId) return null;
  const purpose = state.amendmentBlocPurpose;
  const ids = state.amendmentBloc ?? [];
  return purpose && ids.length > 0 ? { ids: [...ids], purpose } : null;
}

/** What a proposal on screen asks for a decision of the dialog. */
export function admissionPurposeOf(
  decision: SessionAdmissionDecision,
): LiveBlocPurpose {
  return decision === "admitted" ? "admit" : "inadmit";
}

/** The decision a proposal on screen asks for. */
export function admissionDecisionOf(
  purpose: LiveBlocPurpose,
): SessionAdmissionDecision {
  return purpose === "admit" ? "admitted" : "inadmissible";
}

/**
 * What the Mesa may put on screen in a proposal on admission, among `ids`
 * (all of the document when left out), in text order: late amendments
 * pending admission the room can read (isLiveAdmissionProposable, as the
 * server checks). `unpublished` counts the late ones still pending that the
 * Secretaría has not published yet (validated or not), which it publishes
 * first.
 */
export function sessionAdmissionProposalPlan(
  list: readonly AmendmentDto[],
  ids?: readonly string[],
): { ids: string[]; unpublished: number } {
  const wanted = ids ? new Set(ids) : null;
  const pendingLate = list.filter(
    (amendment) =>
      amendment.late &&
      amendment.status === "submitted" &&
      amendment.admission === "pending",
  );
  return {
    ids: sortSessionAmendments(
      pendingLate.filter(
        (amendment) =>
          (!wanted || wanted.has(amendment.id)) &&
          isLiveAdmissionProposable(amendment),
      ),
    ).map((amendment) => amendment.id),
    unpublished: pendingLate.filter((amendment) => !amendment.publishedAt)
      .length,
  };
}

/**
 * Whether the room already has exactly this proposal on screen (its
 * amendments and its purpose): the console then offers to take it off
 * rather than to project it again.
 */
export function isSessionProposalOnScreen(
  proposal: SessionAdmissionProposal | null,
  ids: readonly string[],
  purpose: LiveBlocPurpose,
): boolean {
  return (
    proposal !== null &&
    proposal.purpose === purpose &&
    sameBloc(proposal.ids, ids)
  );
}

/**
 * Whether the dialog would decide otherwise than the room reads: a proposal
 * on screen still has some pending, the ticks touch it, and they are not
 * exactly those (an unpublished one ticked beside them, one of them
 * unticked) or the decision is the opposite of the one proposed (the room
 * assents to admitting them and the console records them inadmissible).
 * The dialog then records nothing until the Mesa projects its choice or
 * matches it: the room decides what it sees, set and direction (in the
 * 80.ª AGO a console approved 17 while the room read 12).
 */
export function isSessionProposalMismatch(
  chosen: readonly string[],
  decision: SessionAdmissionDecision,
  proposal: SessionAdmissionProposal | null,
  byId: ReadonlyMap<string, AmendmentDto>,
): boolean {
  if (!proposal) return false;
  const pending = proposal.ids.filter((id) => {
    const amendment = byId.get(id);
    return amendment !== undefined && isSessionPendingAdmission(amendment);
  });
  if (pending.length === 0) return false;
  const onScreen = new Set(pending);
  if (!chosen.some((id) => onScreen.has(id))) return false;
  if (admissionPurposeOf(decision) !== proposal.purpose) return true;
  return !sameBloc(chosen, pending);
}

/**
 * What the admission dialog opens on: while a proposal on screen still has
 * amendments pending and the Mesa opens it on any of them, on those and
 * the decision the room was asked (as approving a bloc on screen does), so
 * it decides what the room reads; otherwise on what it was opened for.
 */
export function sessionAdmissionTarget(
  requested: readonly string[],
  decision: SessionAdmissionDecision,
  proposal: SessionAdmissionProposal | null,
  byId: ReadonlyMap<string, AmendmentDto>,
): { ids: string[]; decision: SessionAdmissionDecision } {
  const asked = { ids: [...requested], decision };
  if (!proposal) return asked;
  const pending = proposal.ids.filter((id) => {
    const amendment = byId.get(id);
    return amendment !== undefined && isSessionPendingAdmission(amendment);
  });
  if (pending.length === 0) return asked;
  const onScreen = new Set(pending);
  if (!requested.some((id) => onScreen.has(id))) return asked;
  return { ids: pending, decision: admissionDecisionOf(proposal.purpose) };
}
