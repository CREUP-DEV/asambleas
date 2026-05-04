import { createAuthClient } from "better-auth/vue";

export const authClient = createAuthClient();

export const useAuth = () => {
  const session = authClient.useSession();

  const signInWithGoogle = async () => {
    return authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  const signOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          navigateTo("/login");
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
