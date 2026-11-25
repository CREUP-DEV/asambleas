import {
  ACTING_USER_HEADER_NAME,
  CONSOLE_TAB_HEADER_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";
import { currentConsoleTab } from "../session/consoleTab";
import { useMe } from "../security/useMe";

export type ApiMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiSendOptions {
  /** Defaults to POST. */
  method?: ApiMethod;
  /** JSON body (any DTO object) or FormData for uploads. */
  body?: object | FormData | null;
  query?: Record<string, unknown>;
  /**
   * Let the request outlive the page (fetch `keepalive`), for a last word
   * as it closes. Small JSON bodies only.
   */
  keepalive?: boolean;
}

type QueryValue = string | number | boolean | null | undefined;

/**
 * i18n key per HTTP status. Anything else falls back to the caller's key. A
 * 409 without a reason or key is a rule of the current state, worded
 * neutrally; the optimistic lock's «Alguien ha modificado…» needs its
 * reason (`stale_write`, REASON_KEYS).
 */
const STATUS_KEYS: Record<number, string> = {
  400: "common.errors.validation",
  401: "common.errors.unauthorized",
  403: "common.errors.forbidden",
  404: "common.errors.notFound",
  409: "common.errors.conflictState",
  413: "common.errors.tooLarge",
  422: "common.errors.validation",
  429: "common.errors.rateLimited",
};

/**
 * HTTP status of a failed request, or null for network failures and
 * non-HTTP errors. Works with ofetch's FetchError and h3's H3Error.
 */
export function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [
    candidate.statusCode,
    candidate.status,
    candidate.response?.status,
  ]) {
    if (typeof value === "number" && value > 0) return value;
  }
  return null;
}

/**
 * Optimistic-lock and state conflicts: the caller should refetch. Not the
 * stale-identity 409 (isIdentityChanged), after which the page reloads.
 */
export function isConflict(error: unknown): boolean {
  return errorStatus(error) === 409 && !isIdentityChanged(error);
}

/**
 * The i18n key a failed request carries in `data.messageKey` (createError
 * on the server), or null. ofetch's FetchError keeps the response body in
 * `data`, whose own `data` is the one createError got; h3's H3Error keeps
 * that `data` itself.
 */
export function errorMessageKey(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const body = data as { messageKey?: unknown; data?: unknown };
  const nested =
    body.data && typeof body.data === "object"
      ? (body.data as { messageKey?: unknown }).messageKey
      : undefined;
  const key = typeof nested === "string" ? nested : body.messageKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Refusals the server names with a code in `data.reason` instead of an i18n
 * key, and the message that explains each. Only the ones any form may get:
 * the rest are worded by the form that causes them.
 */
const REASON_KEYS: Record<string, string> = {
  // The row changed since the page read it (server/utils/optimisticLock.ts,
  // STALE_WRITE_REASON).
  stale_write: "common.errors.conflict",
  // An account that does not see the executive areas named the CEA.
  executive_member: "common.errors.executiveMember",
  // It chose the CEA as main author or presenter and the server cannot tell
  // which area that is.
  executive_main: "common.errors.executiveMain",
  // On an amendment or a transactional, where every CEA office is named
  // by itself: the generic "CEA" is never an author.
  executive_author: "common.errors.executiveAuthor",
  // A sheet field someone else changed since it was read (the panel shows
  // what is there now).
  control_sheet_stale: "common.errors.controlSheetStale",
  // A «Retirado» by hand on an item with documents.
  control_sheet_withdrawn_document: "common.errors.controlSheetWithdrawn",
  // The Mesa's mark or a result by hand on an item still waiting for a vote.
  control_sheet_awaiting_vote: "common.errors.controlSheetAwaitingVote",
  // The Mesa's mark on an amendment still to be decided.
  control_sheet_amendment_undecided: "common.errors.controlSheetUndecided",
  // A vote on an agenda item while one of its documents is voted: the
  // item is voted through the documents' final votes.
  item_has_voted_documents: "common.errors.itemHasVotedDocuments",
  // The same refusal for someone who may not see those documents yet: it
  // names none.
  item_takes_no_vote: "common.errors.itemTakesNoVote",
  item_is_container: "common.errors.itemIsContainer",
  // The room (Sala) changed under a write: the page shows what is there now.
  seating_stale: "common.errors.seatingStale",
  // A layout save that removes occupied seats, until the client confirms it.
  seating_seats_occupied: "common.errors.seatingSeatsOccupied",
  // A group, a person or a whole room that is no longer there (or an AGET).
  seating_not_found: "common.errors.seatingNotFound",
  // Calendar rules, not a stale read (server/utils/domain/documentRefusals.ts).
  assembly_closed: "common.errors.assemblyClosed",
  documents_deadline_passed: "common.errors.documentsDeadlinePassed",
};

/**
 * The i18n key for the `data.reason` of a failed request (same nesting as
 * errorMessageKey), or null when it has none or it is not in REASON_KEYS.
 */
export function errorReasonKey(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const body = data as { reason?: unknown; data?: unknown };
  const nested =
    body.data && typeof body.data === "object"
      ? (body.data as { reason?: unknown }).reason
      : undefined;
  const reason = typeof nested === "string" ? nested : body.reason;
  return typeof reason === "string" && Object.hasOwn(REASON_KEYS, reason)
    ? REASON_KEYS[reason]!
    : null;
}

/** i18n key (and server `data.messageKey`) of the stale-identity 409. */
export const IDENTITY_CHANGED_KEY = "auth.identityChanged";

/**
 * The server refused a mutation because the page no longer acts as the
 * account it believes (an Admin started, stopped or ran out an
 * impersonation, maybe in another tab): the page must reload.
 */
export function isIdentityChanged(error: unknown): boolean {
  return (
    errorStatus(error) === 409 &&
    errorMessageKey(error) === IDENTITY_CHANGED_KEY
  );
}

/** How long the identity-changed notice shows before the page reloads. */
const IDENTITY_RELOAD_DELAY_MS = 1500;
let identityReloadScheduled = false;

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; cause?: { name?: unknown } };
  return (
    candidate.name === "AbortError" || candidate.cause?.name === "AbortError"
  );
}

function readCsrfToken(fallback: string | null | undefined): string | null {
  if (import.meta.client && typeof document !== "undefined") {
    const prefix = `${CSRF_COOKIE_NAME}=`;
    for (const part of document.cookie.split(";")) {
      const cookie = part.trim();
      if (cookie.startsWith(prefix)) {
        return decodeURIComponent(cookie.slice(prefix.length)) || null;
      }
    }
  }
  return fallback ?? null;
}

/**
 * API client for the Vue side. `get` forwards the session cookie during SSR;
 * `send` adds the CSRF header required by the protected API sections, and
 * `x-acting-user` with the account the page acts as (GET /api/me). When an
 * impersonation started, stopped or ran out meanwhile, the server answers
 * 409 `auth.identityChanged`: `send` says so and reloads the page.
 *
 * Call it from setup (or a plugin/middleware); the returned functions can then
 * be used anywhere, including event handlers.
 */
export function useApi() {
  const requestFetch = useRequestFetch();
  const csrfCookie = useCookie<string | null>(CSRF_COOKIE_NAME);
  const toast = useToast();
  const i18n = useNuxtApp().$i18n;
  const { me, ensure: ensureMe } = useMe();

  function get<T>(url: string, query?: Record<string, QueryValue>): Promise<T> {
    return requestFetch<T>(url, { query }) as Promise<T>;
  }

  /** Says the account changed under the page, then reloads it (once). */
  function reloadForIdentityChange(): void {
    toast.add({
      id: "api-identity-changed",
      title: i18n.t(IDENTITY_CHANGED_KEY),
      color: "warning",
      icon: "i-lucide-refresh-ccw",
    });
    if (!import.meta.client || identityReloadScheduled) return;
    identityReloadScheduled = true;
    setTimeout(() => {
      reloadNuxtApp({ force: true });
    }, IDENTITY_RELOAD_DELAY_MS);
  }

  async function send<T = unknown>(
    url: string,
    options: ApiSendOptions = {},
  ): Promise<T> {
    const token = readCsrfToken(csrfCookie.value);
    // The server compares it with the account the request really runs as.
    const actingUserId = (me.value ?? (await ensureMe()))?.id ?? null;
    const headers: Record<string, string> = {};
    if (token) headers[CSRF_HEADER_NAME] = token;
    if (actingUserId) headers[ACTING_USER_HEADER_NAME] = actingUserId;
    // From the session console: which tab, for control of the projection.
    const consoleTab = currentConsoleTab();
    if (consoleTab) headers[CONSOLE_TAB_HEADER_NAME] = consoleTab;
    // Nitro's typed routes cannot narrow a runtime URL, so the method union
    // does not type-check against them; the request shape is plain ofetch.
    const fetchJson = requestFetch as unknown as (
      url: string,
      options: {
        method: ApiMethod;
        body?: Record<string, unknown> | FormData;
        query?: Record<string, unknown>;
        headers?: Record<string, string>;
        keepalive?: boolean;
      },
    ) => Promise<T>;
    try {
      return await fetchJson(url, {
        method: options.method ?? "POST",
        body: (options.body ?? undefined) as
          Record<string, unknown> | undefined,
        query: options.query,
        headers,
        ...(options.keepalive ? { keepalive: true } : {}),
      });
    } catch (error) {
      if (isIdentityChanged(error)) reloadForIdentityChange();
      throw error;
    }
  }

  /**
   * Shows a localized toast for a failed request and returns its status.
   * With `fallbackKey`, that key is the title and the status explains why;
   * without it, the status message is the title. Server messages are never
   * shown: they are untranslated, and on 5xx they are internal. An i18n key
   * the server sent with a 4xx (`data.messageKey`) explains it better than
   * the status, when this locale has it; so does the message of a refusal
   * it named in `data.reason` (errorReasonKey). The identity-changed 409 was
   * already said by `send`, which reloads the page: nothing more shows.
   */
  function notifyError(error: unknown, fallbackKey?: string): number | null {
    if (isAbort(error)) return null;
    const status = errorStatus(error);
    if (isIdentityChanged(error)) return status;
    const messageKey =
      status !== null && status < 500
        ? (errorMessageKey(error) ?? errorReasonKey(error))
        : null;
    const statusKey =
      messageKey && i18n.te(messageKey)
        ? messageKey
        : status === null
          ? "common.errors.network"
          : (STATUS_KEYS[status] ??
            (status >= 500 ? "common.errors.server" : null));

    const title = i18n.t(fallbackKey ?? statusKey ?? "common.errors.unknown");
    const description =
      fallbackKey && statusKey ? i18n.t(statusKey) : undefined;

    toast.add({
      id: `api-error-${fallbackKey ?? ""}-${statusKey ?? status ?? "unknown"}`,
      title,
      description,
      color: status === 409 ? "warning" : "error",
      icon: status === 409 ? "i-lucide-refresh-ccw" : "i-lucide-circle-alert",
    });
    return status;
  }

  return { get, send, notifyError, isConflict, errorStatus, errorMessageKey };
}
