import { defineEventHandler } from "h3";
import { attachAuthContext } from "../utils/auth/rbac";
import {
  assertSameOriginMutation,
  ensureCsrfCookie,
  assertCsrfMutation,
} from "../utils/auth/requestProtection";

export default defineEventHandler(async (event) => {
  if (event.method === "OPTIONS") {
    return;
  }

  assertSameOriginMutation(event);
  await attachAuthContext(event);
  ensureCsrfCookie(event);
  assertCsrfMutation(event);
});
