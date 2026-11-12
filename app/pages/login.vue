<script setup lang="ts">
import { safeRedirectPath } from "~/middleware/-session";

const { t } = useI18n();
const { signInWithGoogle } = useAuth();
const route = useRoute();
const localePath = useLocalePath();
const isSigningIn = ref(false);

/** Where Google sends back to: a path of this site, never another host. */
const redirectPath = computed(
  () => safeRedirectPath(route.query.redirect) ?? localePath("/"),
);

/**
 * Messages of the sign-in refusals better-auth sends back here as
 * `?error=<code>` (SIGN_IN_ERROR_CODES in server/utils/auth/auth.ts). Any
 * other code (Google cancelled, an expired state) gets the general one.
 * `error_description` is never shown: it is untranslated server text.
 */
const SIGN_IN_ERROR_KEYS: Readonly<Record<string, string>> = {
  access_revoked: "auth.signInErrors.accessRevoked",
  sign_in_unavailable: "auth.signInErrors.unavailable",
};

const signInError = computed(() => {
  const raw = route.query.error;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (typeof code !== "string" || !code.trim()) return null;
  // Own keys only: `?error=constructor` must not reach the prototype.
  const key = Object.hasOwn(SIGN_IN_ERROR_KEYS, code)
    ? SIGN_IN_ERROR_KEYS[code]
    : undefined;
  return t(key ?? "auth.signInErrors.generic");
});

const handleGoogleSignIn = async () => {
  if (isSigningIn.value) {
    return;
  }

  isSigningIn.value = true;

  try {
    await signInWithGoogle(redirectPath.value);
  } finally {
    isSigningIn.value = false;
  }
};

definePageMeta({
  layout: false,
});

useHead({
  title: t("auth.signIn"),
});
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-elevated">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex flex-col items-center gap-2">
          <UIcon name="i-tabler-list-numbers" class="size-10 text-primary" />
          <h1 class="text-2xl font-bold text-primary">
            {{ t("app.title") }}
          </h1>
        </div>
      </template>

      <div class="flex flex-col items-center gap-4">
        <p class="text-sm text-muted">
          {{ t("app.description") }}
        </p>
        <UAlert
          v-if="signInError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('auth.signInErrors.title')"
          :description="signInError"
        />
        <UButton
          icon="i-tabler-brand-google"
          :label="t('auth.signInWithGoogle')"
          size="lg"
          :loading="isSigningIn"
          block
          @click="handleGoogleSignIn"
        />
      </div>
    </UCard>
  </main>
</template>
