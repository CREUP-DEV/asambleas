import { createAuthClient } from "better-auth/vue";

export const authClient = createAuthClient();

export const useAuth = () => {
  const session = authClient.useSession();
  const localePath = useLocalePath();
  const { clear: clearPermissions } = usePermissions();

  const signInWithGoogle = async (callbackURL = "/") => {
    return authClient.signIn.social({
      provider: "google",
      callbackURL,
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

  return {
    session,
    signInWithGoogle,
    signOut,
  };
};
