import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

export type ApiMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiSendOptions {
  /** Defaults to POST. */
  method?: ApiMethod;
  /** JSON body (any DTO object) or FormData for uploads. */
  body?: object | FormData | null;
  query?: Record<string, unknown>;
}

type QueryValue = string | number | boolean | null | undefined;

/** i18n key per HTTP status. Anything else falls back to the caller's key. */
const STATUS_KEYS: Record<number, string> = {
  400: "common.errors.validation",
  401: "common.errors.unauthorized",
  403: "common.errors.forbidden",
  404: "common.errors.notFound",
  409: "common.errors.conflict",
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

/** Optimistic-lock and state conflicts: the caller should refetch. */
export function isConflict(error: unknown): boolean {
  return errorStatus(error) === 409;
}

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
 * `send` adds the CSRF header required by the protected API sections.
 *
 * Call it from setup (or a plugin/middleware); the returned functions can then
 * be used anywhere, including event handlers.
 */
export function useApi() {
  const requestFetch = useRequestFetch();
  const csrfCookie = useCookie<string | null>(CSRF_COOKIE_NAME);
  const toast = useToast();
  const i18n = useNuxtApp().$i18n;

  function get<T>(url: string, query?: Record<string, QueryValue>): Promise<T> {
    return requestFetch<T>(url, { query }) as Promise<T>;
  }

  function send<T = unknown>(
    url: string,
    options: ApiSendOptions = {},
  ): Promise<T> {
    const token = readCsrfToken(csrfCookie.value);
    return requestFetch<T>(url, {
      method: options.method ?? "POST",
      body: (options.body ?? undefined) as Record<string, unknown> | undefined,
      query: options.query,
      headers: token ? { [CSRF_HEADER_NAME]: token } : undefined,
    }) as Promise<T>;
  }

  /**
   * Shows a localized toast for a failed request and returns its status.
   * With `fallbackKey`, that key is the title and the status explains why;
   * without it, the status message is the title. Server messages are never
   * shown: they are untranslated, and on 5xx they are internal.
   */
  function notifyError(error: unknown, fallbackKey?: string): number | null {
    if (isAbort(error)) return null;
    const status = errorStatus(error);
    const statusKey =
      status === null
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
      icon:
        status === 409 ? "i-lucide-refresh-ccw" : "i-lucide-circle-alert",
    });
    return status;
  }

  return { get, send, notifyError, isConflict, errorStatus };
}
