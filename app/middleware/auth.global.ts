const LOGIN_PATH = "/login";
const SESSION_RECHECK_INTERVAL_MS = 2 * 60 * 1000;

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === LOGIN_PATH) {
    return;
  }

  const sessionVerified = useState("session-verified", () => false);
  const lastCheckedAt = useState<number>("session-last-checked", () => 0);

  if (import.meta.client && sessionVerified.value) {
    const timeSinceCheck = Date.now() - lastCheckedAt.value;
    if (timeSinceCheck < SESSION_RECHECK_INTERVAL_MS) {
      return;
    }
  }

  try {
    await $fetch("/api/auth/session", {
      headers: import.meta.server ? useRequestHeaders(["cookie"]) : undefined,
    });
    sessionVerified.value = true;
    lastCheckedAt.value = Date.now();
  } catch {
    sessionVerified.value = false;
    lastCheckedAt.value = 0;
    return navigateTo(LOGIN_PATH);
  }
});
