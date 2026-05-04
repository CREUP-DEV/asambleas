<script setup lang="ts">
const { t } = useI18n();
const { signInWithGoogle } = useAuth();
const route = useRoute();
const isSigningIn = ref(false);

const redirectPath = computed(() => {
  const r = route.query.redirect;
  return typeof r === "string" && r.startsWith("/") ? r : "/";
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
        <div class="text-center">
          <h1 class="text-2xl font-bold text-primary">
            {{ t("app.title") }}
          </h1>
        </div>
      </template>

      <div class="flex flex-col items-center gap-4">
        <p class="text-sm text-muted">
          {{ t("app.description") }}
        </p>
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
