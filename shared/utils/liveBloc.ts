import { LIVE_BLOC_PURPOSES, type LiveBlocPurpose } from "../constants/domain";
import type { LiveStateBody } from "../types/api";

/**
 * A bloc on screen (user's decision of 2026-11-19): amendments of the
 * document on screen the Mesa proposes to approve together. It takes the
 * place of the amendment and the vote on screen, and they take its place:
 * the live state points at one of the three at most. A purpose (user's
 * decision of 2026-11-21) makes the same bloc a proposal to admit late
 * amendments to debate or not, rather than a second pointer.
 */

/** What the live state points at, as the server stores it. */
export interface LivePointerFields {
  agendaItemId: string | null;
  documentId: string | null;
  amendmentId: string | null;
  /** Null when there is no bloc (never an empty list). */
  amendmentBloc: string[] | null;
  /**
   * The bloc as alternatives to vote between (user's decision of
   * 2026-11-20): the amendments of each option, exactly those of the bloc;
   * null for a bloc proposed for approval, and always without a bloc.
   */
  amendmentBlocOptions: string[][] | null;
  /**
   * What the bloc proposes (user's decision of 2026-11-21): null to approve
   * it, and always without a bloc; `admit` or `inadmit` for late amendments
   * pending admission. Never with options.
   */
  amendmentBlocPurpose: LiveBlocPurpose | null;
  voteId: string | null;
}

/** A bloc as stored: an empty list is no bloc. */
export function normalizeBloc(
  ids: readonly string[] | null | undefined,
): string[] | null {
  return ids && ids.length > 0 ? [...ids] : null;
}

/** Whether two blocs hold the same amendments, in any order. */
export function sameBloc(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Bloc options as stored: null unless they are two or more non-empty sets
 * that together hold exactly the bloc's amendments, each once.
 */
export function normalizeBlocOptions(
  options: readonly (readonly string[])[] | null | undefined,
  bloc: readonly string[] | null,
): string[][] | null {
  if (!options || !bloc || options.length < 2) return null;
  if (options.some((ids) => ids.length === 0)) return null;
  const flat = options.flat();
  if (flat.length !== new Set(flat).size || !sameBloc(flat, bloc)) return null;
  return options.map((ids) => [...ids]);
}

/**
 * A bloc's purpose as stored: one of LIVE_BLOC_PURPOSES with a bloc and no
 * options, else null (to approve it, or no bloc at all).
 */
export function normalizeBlocPurpose(
  purpose: string | null | undefined,
  bloc: readonly string[] | null,
  options: readonly (readonly string[])[] | null = null,
): LiveBlocPurpose | null {
  if (!bloc || options) return null;
  return (LIVE_BLOC_PURPOSES as readonly string[]).includes(purpose ?? "")
    ? (purpose as LiveBlocPurpose)
    : null;
}

/**
 * Whether an amendment may go on screen in a proposal to admit it or not
 * (user's decision of 2026-11-21): late, presented, validated and
 * published, and still waiting for that decision. The room reads only what
 * is published, so the Secretaría publishes the rest first.
 */
export function isLiveAdmissionProposable(amendment: {
  late: boolean;
  status: string;
  admission: string;
  validatedAt: Date | string | null;
  publishedAt: Date | string | null;
}): boolean {
  return (
    amendment.late &&
    amendment.status === "submitted" &&
    amendment.admission === "pending" &&
    amendment.validatedAt !== null &&
    amendment.publishedAt !== null
  );
}

/** Whether two sets of options are the same, option by option. */
function sameOptions(
  a: readonly (readonly string[])[] | null,
  b: readonly (readonly string[])[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.length === b.length && a.every((ids, index) => sameBloc(ids, b[index]))
  );
}

/** The pointer fields, in the order `live_changed` lists them. */
export const LIVE_POINTER_KEYS = [
  "agendaItemId",
  "documentId",
  "amendmentId",
  "amendmentBloc",
  "amendmentBlocOptions",
  "amendmentBlocPurpose",
  "voteId",
] as const satisfies readonly (keyof LivePointerFields)[];

/**
 * The pointer fields that differ between two states (the bloc by value);
 * whatever else the states carry is not looked at.
 */
export function changedLiveFields(
  previous: LivePointerFields,
  next: LivePointerFields,
): (keyof LivePointerFields)[] {
  return LIVE_POINTER_KEYS.filter((key) =>
    key === "amendmentBloc"
      ? !sameBloc(previous.amendmentBloc, next.amendmentBloc)
      : key === "amendmentBlocOptions"
        ? !sameOptions(previous.amendmentBlocOptions, next.amendmentBlocOptions)
        : next[key] !== previous[key],
  );
}

export type LivePointerError =
  "bloc_with_pointer" | "foreign_document" | "bloc_options" | "bloc_purpose";

/**
 * What a PUT .../live-state body points at next, once the server has
 * checked its ids: `owner` is the document of the amendment or the bloc it
 * sends (null when it sends neither). `undefined` keeps a field, `null`
 * clears it, and:
 * - an amendment or a bloc selects its document, or must belong to the one
 *   the body names (`foreign_document`);
 * - a bloc takes off the amendment and the vote; a bloc together with an
 *   amendment or a vote is refused (`bloc_with_pointer`);
 * - an amendment or a vote takes off the bloc;
 * - another document takes off the amendment and the bloc of the previous
 *   one (unless the body sends them);
 * - a bloc sent with options puts them on screen with it, which must split
 *   exactly its amendments (`bloc_options`); a bloc sent without them, or
 *   taken off, takes them off;
 * - a bloc sent with a purpose (admit, inadmit) proposes that instead of
 *   approving it; a purpose never comes with options nor without a bloc
 *   (`bloc_purpose`), and a bloc sent without one, or taken off, has none.
 * The agenda item of a new document is the server's to fill.
 */
export function nextLivePointer(
  previous: LivePointerFields,
  body: Pick<
    LiveStateBody,
    | "agendaItemId"
    | "documentId"
    | "amendmentId"
    | "amendmentBloc"
    | "amendmentBlocOptions"
    | "amendmentBlocPurpose"
    | "voteId"
  >,
  owner: string | null,
): { next: LivePointerFields } | { error: LivePointerError } {
  const blocOn = (body.amendmentBloc?.length ?? 0) > 0;
  if (blocOn && (body.amendmentId || body.voteId)) {
    return { error: "bloc_with_pointer" };
  }
  if (
    body.amendmentBlocPurpose &&
    (!blocOn || (body.amendmentBlocOptions?.length ?? 0) > 0)
  ) {
    return { error: "bloc_purpose" };
  }
  const next: LivePointerFields = { ...previous };
  for (const key of [
    "agendaItemId",
    "documentId",
    "amendmentId",
    "voteId",
  ] as const) {
    if (body[key] !== undefined) next[key] = body[key] ?? null;
  }
  if (body.amendmentBloc !== undefined) {
    next.amendmentBloc = normalizeBloc(body.amendmentBloc);
    next.amendmentBlocOptions = normalizeBlocOptions(
      body.amendmentBlocOptions,
      next.amendmentBloc,
    );
    if (
      (body.amendmentBlocOptions?.length ?? 0) > 0 &&
      next.amendmentBlocOptions === null
    ) {
      return { error: "bloc_options" };
    }
    next.amendmentBlocPurpose = body.amendmentBlocPurpose ?? null;
  }
  if (owner !== null) {
    if (body.documentId === undefined) next.documentId = owner;
    else if (next.documentId !== owner) return { error: "foreign_document" };
  }
  if (blocOn) {
    next.amendmentId = null;
    next.voteId = null;
  }
  if (body.amendmentId || body.voteId) next.amendmentBloc = null;
  if (next.documentId !== previous.documentId) {
    if (body.amendmentId === undefined) next.amendmentId = null;
    if (body.amendmentBloc === undefined) next.amendmentBloc = null;
  }
  if (next.amendmentBloc === null) {
    next.amendmentBlocOptions = null;
    next.amendmentBlocPurpose = null;
  }
  return { next };
}
