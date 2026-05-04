const SESSION_RECHECK_INTERVAL_MS = 2 * 60 * 1000;
const LOGIN_ROUTE_PATTERN = /^(\/[a-z]{2})?\/login$/;

export default defineNuxtRouteMiddleware(async (to) => {
  if (LOGIN_ROUTE_PATTERN.test(to.path)) {
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

    const { fetchPermissions, loaded } = usePermissions();
    if (!loaded.value) {
      await fetchPermissions();
    }
  } catch {
    sessionVerified.value = false;
    lastCheckedAt.value = 0;
    return navigateTo({
      path: "/login",
      query: to.fullPath !== "/" ? { redirect: to.fullPath } : undefined,
    });
  }
});
