export const SESSION_COOKIE_NAME_PROD = "__Host-session";
export const SESSION_COOKIE_NAME_DEV = "session";

export const CSRF_COOKIE_NAME = "csrf-token";
export const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * Header every unsafe request carries with the id of the user the page
 * believes it acts as (MeDto.id). While an Admin impersonates, or right
 * after it stops in another tab, a mismatch answers 409 with
 * `data.messageKey: "auth.identityChanged"` and the client reloads, so a
 * form opened as one identity never submits as another.
 */
export const ACTING_USER_HEADER_NAME = "x-acting-user";

/** Fixed length of an impersonation, from its start; never renewed. */
export const IMPERSONATION_TTL_MINUTES = 60;
