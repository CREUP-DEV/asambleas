<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{
  error: NuxtError;
}>();

const { t, te } = useI18n();
const localePath = useLocalePath();
const router = useRouter();

const STATUS_VARIANTS: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "notFound",
};

const statusCode = computed(() => props.error.statusCode ?? 500);

const variant = computed(
  () =>
    STATUS_VARIANTS[statusCode.value] ??
    (statusCode.value >= 500 ? "server" : "unknown"),
);

/**
 * Pages raise their own copy by passing an i18n key through `data.messageKey`.
 * Nothing else from the error is rendered: `message` carries untranslated
 * framework text on 4xx and the server-side exception on 5xx, which has no
 * business reaching a browser.
 */
const messageKey = computed(() => {
  const data = props.error.data as { messageKey?: unknown } | undefined;
  const key = typeof data?.messageKey === "string" ? data.messageKey : null;
  return key && te(key) ? key : null;
});

const title = computed(() => t(`errors.page.${variant.value}.title`));
const description = computed(() =>
  messageKey.value
    ? t(messageKey.value)
    : t(`errors.page.${variant.value}.description`),
);

useHead({
  title: () => `${title.value} | ${t("app.title")}`,
});

const goHome = () => clearError({ redirect: localePath("/") });

const goBack = () => {
  if (router.options.history.state.back) {
    clearError();
    router.back();
    return;
  }

  goHome();
};
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="max-w-prose text-center">
      <p class="text-primary text-6xl font-bold">
        {{ statusCode }}
      </p>
      <h1 class="mt-4 text-2xl font-semibold">
        {{ title }}
      </h1>
      <p class="text-muted mt-2">
        {{ description }}
      </p>
      <div class="mt-8 flex flex-wrap justify-center gap-2">
        <UButton size="lg" icon="i-tabler-home" @click="goHome">
          {{ t("nav.home") }}
        </UButton>
        <UButton
          size="lg"
          variant="soft"
          color="neutral"
          icon="i-tabler-arrow-left"
          @click="goBack"
        >
          {{ t("errors.page.goBack") }}
        </UButton>
      </div>
    </div>
  </div>
</template>
