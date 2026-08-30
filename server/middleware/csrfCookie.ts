import { defineEventHandler } from "h3";
import { ensureCsrfCookie } from "../utils/auth/requestProtection";

/**
 * Issues the CSRF cookie on every response, including server-rendered pages.
 *
 * The section handlers call `ensureCsrfCookie` too, but during SSR those run as
 * internal `$fetch` calls whose `Set-Cookie` never reaches the browser. A
 * freshly loaded page would then hold no token and its first mutation would be
 * rejected. This runs on the page response itself, so the token is always there
 * before any client code can mutate. It only sets a cookie; the assertions stay
 * in the section handlers.
 */
export default defineEventHandler((event) => {
  ensureCsrfCookie(event);
});
