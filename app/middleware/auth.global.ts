import {
  isLoginPath,
  localeOfPath,
  safeRedirectPath,
  sessionFailureAction,
  shouldCheckSession,
} from "./-session";

type SessionAnswer = { user: unknown | null };

/**
 * Every page but the login page needs a session. Only a 401 from GET
 * /api/auth/session sends to the login page (of the language the page was
 * in); a network error, a 429 or a 5xx lets the navigation through and
 * leaves the last verdict as it was, so a lost request on the venue's
 * Wi-Fi or a deployment never signs anyone out.
 */
export default defineNuxtRouteMiddleware(async (to, from) => {
  const sessionVerified = useState("session-verified", () => false);
  const lastCheckedAt = useState<number>("session-last-checked", () => 0);
  const nuxtApp = useNuxtApp();
  const localePath = useLocalePath();
  const locale = localeOfPath(
    to.path,
    nuxtApp.$i18n.localeCodes.value,
    nuxtApp.$i18n.defaultLocale,
  );

  const fetchSession = () =>
    $fetch<SessionAnswer>("/api/auth/session", {
      headers: import.meta.server ? useRequestHeaders(["cookie"]) : undefined,
    });

  if (isLoginPath(to.path)) {
    // A refused sign-in comes back here with `?error=`: show it.
    if (to.query.error !== undefined) return;
    // Someone already signed in goes where they were headed. Always asks
    // the server, since signing out does not reset the cached verdict.
    try {
      const session = await fetchSession();
      if (!session?.user) return;
    } catch (error) {
      if (sessionFailureAction(error) === "redirect") {
        sessionVerified.value = false;
        lastCheckedAt.value = 0;
      }
      return;
    }
    return navigateTo(
      safeRedirectPath(to.query.redirect) ?? localePath("/", locale),
      { replace: true },
    );
  }

  if (
    !shouldCheckSession({
      client: import.meta.client,
      verified: sessionVerified.value,
      lastCheckedAt: lastCheckedAt.value,
      now: Date.now(),
      toPath: to.path,
      fromPath: from?.path,
    })
  ) {
    return;
  }

  try {
    await fetchSession();
  } catch (error) {
    if (sessionFailureAction(error) === "keep") return;
    sessionVerified.value = false;
    lastCheckedAt.value = 0;
    return navigateTo(
      localePath(
        {
          path: "/login",
          query: to.fullPath !== "/" ? { redirect: to.fullPath } : undefined,
        },
        locale,
      ),
    );
  }
  sessionVerified.value = true;
  lastCheckedAt.value = Date.now();

  const { fetchPermissions, loaded } = usePermissions();
  if (!loaded.value) {
    // useMe keeps what it had on transient failures and never throws.
    await fetchPermissions();
  }
});
