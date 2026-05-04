import { randomBytes } from "node:crypto";
import {
  createError,
  getCookie,
  getRequestHeader,
  getRequestURL,
  setCookie,
  type H3Event,
} from "h3";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isUnsafeMethod(method: string) {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

function createCsrfToken() {
  return randomBytes(32).toString("base64url");
}

function getCsrfCookieAttributes() {
  return {
    httpOnly: false,
    path: "/",
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

function isSameOriginRequest(event: H3Event) {
  const requestOrigin = getRequestURL(event).origin;
  const originHeader = getRequestHeader(event, "origin")?.trim();

  if (originHeader) {
    try {
      return new URL(originHeader).origin === requestOrigin;
    } catch {
      return false;
    }
  }

  const fetchSite = getRequestHeader(event, "sec-fetch-site")
    ?.trim()
    .toLowerCase();
  return fetchSite === "same-origin";
}

export function assertSameOriginMutation(event: H3Event) {
  if (!isUnsafeMethod(event.method)) {
    return;
  }

  if (isSameOriginRequest(event)) {
    return;
  }

  throw createError({
    statusCode: 403,
    message: "Solicitud no permitida.",
  });
}

export function ensureCsrfCookie(event: H3Event) {
  const currentToken = getCookie(event, CSRF_COOKIE_NAME)?.trim();

  if (currentToken) {
    return currentToken;
  }

  const nextToken = createCsrfToken();
  setCookie(event, CSRF_COOKIE_NAME, nextToken, getCsrfCookieAttributes());
  return nextToken;
}

export function assertCsrfMutation(event: H3Event) {
  if (!isUnsafeMethod(event.method)) {
    return;
  }

  const csrfCookieToken = getCookie(event, CSRF_COOKIE_NAME)?.trim();
  const csrfHeaderToken = getRequestHeader(event, CSRF_HEADER_NAME)?.trim();

  if (
    csrfCookieToken &&
    csrfHeaderToken &&
    csrfCookieToken === csrfHeaderToken
  ) {
    return;
  }

  throw createError({
    statusCode: 403,
    message: "Solicitud no permitida.",
  });
}
