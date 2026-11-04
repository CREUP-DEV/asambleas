<script setup lang="ts">
import { en, es } from "@nuxt/ui/locale";

const { locale } = useI18n();

const uiLocales = { en, es };
const currentUiLocale = computed(
  () => uiLocales[locale.value as keyof typeof uiLocales] ?? uiLocales.es,
);

useHead({
  htmlAttrs: {
    lang: locale,
  },
});
</script>

<template>
  <UApp :locale="currentUiLocale">
    <NuxtLoadingIndicator color="var(--ui-primary)" :height="2" />
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
