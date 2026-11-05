<script setup lang="ts">
import { en, es } from "@nuxt/ui/locale";

const { t, locale } = useI18n();

const uiLocales = { en, es };
const currentUiLocale = computed(
  () => uiLocales[locale.value as keyof typeof uiLocales] ?? uiLocales.es,
);

// reka-ui names the toast region "Notifications (F8)" and Nuxt UI does not
// forward a label to it, so it is set here once the region exists and again
// when the language changes. Vue never rewrites it, since reka's own value
// never changes. Drop this once Nuxt UI forwards the viewport label.
function labelToastRegion(label: string, retry = true): void {
  const region = document.querySelector(
    '[role="region"] > ol[data-slot="viewport"]',
  )?.parentElement;
  if (region) region.setAttribute("aria-label", label);
  else if (retry) requestAnimationFrame(() => labelToastRegion(label, false));
}
onMounted(() => {
  watch(
    () => t("shell.toastRegion"),
    (label) => {
      void nextTick(() => labelToastRegion(label));
    },
    { immediate: true },
  );
});

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
    <!-- Here rather than in the layout, so pages without one (projection,
         print) show it too while an Admin acts as another account. -->
    <ShellImpersonationBanner />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
