import { defineEventHandler } from "h3";
import { attachAuthContext, requireAdmin } from "../utils/auth/rbac";
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
  await requireAdmin(event);
  ensureCsrfCookie(event);
  assertCsrfMutation(event);
});
