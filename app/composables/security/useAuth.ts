import { createAuthClient } from "better-auth/vue";
import type { ImpersonationDto } from "~~/shared/types/api";

export const authClient = createAuthClient();

/**
 * Sign-in, sign-out and acting as another account. Identity comes only
 * from `useMe` (GET /api/me): better-auth's own session keeps reporting the
 * signed-in Admin while they act as another account, so it is never read
 * here.
 */
export const useAuth = () => {
  const localePath = useLocalePath();
  const { clear: clearPermissions } = usePermissions();
  const api = useApi();

  /**
   * Google sign-in, back at `callbackURL`. A refused sign-in (an account
   * the Intranet deleted, SIGN_IN_ERROR_CODES) comes back to the login page
   * of the current language with `?error=<code>` and the same `redirect`,
   * instead of better-auth's fallback (`onAPIError.errorURL`, the Spanish
   * /login without it).
   */
  const signInWithGoogle = async (callbackURL = "/") => {
    return authClient.signIn.social({
      provider: "google",
      callbackURL,
      errorCallbackURL: localePath({
        path: "/login",
        query: callbackURL !== "/" ? { redirect: callbackURL } : {},
      }),
    });
  };

  const signOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          clearPermissions();
          navigateTo(localePath("/login"));
        },
      },
    });
  };

  /**
   * The signed-in Admin starts acting as `userId` (POST
   * /api/admin/users/[id]/impersonate) and lands on that account's home
   * page. A full reload drops every cached answer, the signed-in user and
   * live connections of the Admin. Throws what the server refused.
   */
  const startImpersonating = async (
    userId: string,
    reason: string,
  ): Promise<ImpersonationDto> => {
    const started = await api.send<ImpersonationDto>(
      `/api/admin/users/${encodeURIComponent(userId)}/impersonate`,
      { method: "POST", body: { reason } },
    );
    reloadNuxtApp({ path: localePath("/"), force: true });
    return started;
  };

  /**
   * Goes back to the signed-in Admin's own account (DELETE
   * /api/me/impersonation) and reloads the page as them. A 409 means it
   * had already ended (time limit, or another tab): the reload shows that
   * too. Throws anything else.
   */
  const stopImpersonating = async (): Promise<void> => {
    try {
      await api.send("/api/me/impersonation", { method: "DELETE" });
    } catch (error) {
      if (api.errorStatus(error) !== 409) throw error;
    }
    reloadNuxtApp({ force: true });
  };

  return {
    signInWithGoogle,
    signOut,
    startImpersonating,
    stopImpersonating,
  };
};
