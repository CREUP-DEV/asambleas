import {
  ACTING_USER_HEADER_NAME,
  CONSOLE_TAB_HEADER_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";
import {
  errorReasonMessageKey,
  isErrorReason,
  isListedErrorReason,
  listedErrorReasonMessageKey,
  type ErrorReason,
} from "~~/shared/constants/errorReasons";
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
 * reason (`stale_write`, ERROR_REASONS in shared/constants/errorReasons.ts).
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

/** One problem of a body with several (`data.reasons[]`, validateOps). */
export interface ErrorListedReason {
  /** The op at fault, or -1 for the whole body. */
  index: number;
  reason: string;
}

/** What a failed request says about why, read from either nesting. */
export interface ErrorPayload {
  /** HTTP status, or null for a network failure or a non-HTTP error. */
  status: number | null;
  /** `data.reason`, when it is a code of the catalog. */
  reason: ErrorReason | null;
  /** `data.reasons[]`, the problems of a body with several. */
  reasons: ErrorListedReason[];
  /** `data.messageKey`, an i18n key for the global barriers. */
  messageKey: string | null;
  /**
   * The refusal's own data (what `fail` got: the row as it is now, the
   * counts that block it…), or an empty object.
   */
  data: Record<string, unknown>;
}

/**
 * The shape before ARQ-1, read during one release so that a page and a
 * server of different releases understand each other: a code in
 * `data.code`, the flags `stale` and `pendingConciliation`, and the two
 * codes renamed. Remove it, and the server's `code` and flags, in the
 * release after.
 */
const LEGACY_REASONS: Record<string, ErrorReason> = {
  empty: "docx_empty",
  no_change: "form_correction_no_change",
};

function legacyReason(data: Record<string, unknown>): ErrorReason | null {
  if (
    typeof data.reason === "string" &&
    Object.hasOwn(LEGACY_REASONS, data.reason)
  ) {
    return LEGACY_REASONS[data.reason]!;
  }
  if (isErrorReason(data.code)) return data.code;
  if (data.pendingConciliation === true) {
    return "form_correction_pending_conciliation";
  }
  if (data.stale === true) return "form_correction_stale";
  return null;
}

/** A plain object, or null. */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The one reader of a failed request's body (ARQ-1): every caller that
 * branches on why a request failed reads this, never `error.data` by hand.
 * ofetch's FetchError keeps the response body in `data`, whose own `data`
 * is what `fail` got; h3's H3Error keeps that `data` itself. Compare
 * `reason` with the catalog's constants (`shared/constants/errorReasons.ts`),
 * never with a literal.
 */
export function errorPayload(error: unknown): ErrorPayload {
  const status = errorStatus(error);
  const outer = record(
    error && typeof error === "object"
      ? (error as { data?: unknown }).data
      : undefined,
  );
  // A response body (it has `statusCode`) without `data` carries none.
  const data =
    record(outer?.data) ?? (outer && !("statusCode" in outer) ? outer : {});
  const messageKey =
    typeof data.messageKey === "string" && data.messageKey.length > 0
      ? data.messageKey
      : null;
  const reason = isErrorReason(data.reason) ? data.reason : legacyReason(data);
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.flatMap((item): ErrorListedReason[] => {
        const entry = record(item);
        return entry && typeof entry.reason === "string"
          ? [
              {
                index: typeof entry.index === "number" ? entry.index : -1,
                reason: entry.reason,
              },
            ]
          : [];
      })
    : [];
  return { status, reason, reasons, messageKey, data };
}

/** The i18n key a failed request carries in `data.messageKey`, or null. */
export function errorMessageKey(error: unknown): string | null {
  return errorPayload(error).messageKey;
}

/**
 * The i18n key of the `data.reason` of a failed request, or null when it has
 * none or its code has no key of its own (ERROR_REASONS).
 */
export function errorReasonKey(error: unknown): string | null {
  const { reason } = errorPayload(error);
  return reason ? errorReasonMessageKey(reason) : null;
}

/**
 * The i18n keys that may word a failed request, best first: its
 * `messageKey`, its reason's key, and the key of the first code of its
 * `reasons[]` that has one. None for a 5xx, whose body is internal.
 * `notifyError` takes the first its locale has, then the status's.
 */
export function errorKeyCandidates(payload: ErrorPayload): string[] {
  if (payload.status === null || payload.status >= 500) return [];
  const keys: string[] = [];
  if (payload.messageKey) keys.push(payload.messageKey);
  const reasonKey = payload.reason
    ? errorReasonMessageKey(payload.reason)
    : null;
  if (reasonKey) keys.push(reasonKey);
  for (const item of payload.reasons) {
    if (isListedErrorReason(item.reason)) {
      keys.push(listedErrorReasonMessageKey(item.reason));
      break;
    }
  }
  return keys;
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
   * shown: they are untranslated, and on 5xx they are internal. With a 4xx,
   * what the server named explains it better than the status, when this
   * locale has its key (errorKeyCandidates): `data.messageKey`, the code in
   * `data.reason`, or the first code of `data.reasons[]`. The
   * identity-changed 409 was already said by `send`, which reloads the
   * page: nothing more shows.
   */
  function notifyError(error: unknown, fallbackKey?: string): number | null {
    if (isAbort(error)) return null;
    const payload = errorPayload(error);
    const { status } = payload;
    if (isIdentityChanged(error)) return status;
    const messageKey = errorKeyCandidates(payload).find((key) => i18n.te(key));
    const statusKey =
      messageKey ??
      (status === null
        ? "common.errors.network"
        : (STATUS_KEYS[status] ??
          (status >= 500 ? "common.errors.server" : null)));

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
