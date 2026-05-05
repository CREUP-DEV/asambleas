<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();

useHead({
  title: t("nav.home"),
});

const links = computed(() => [
  {
    label: t("hero.cta"),
    to: localePath("/asambleas"),
    trailingIcon: "i-tabler-arrow-right",
    size: "xl" as const,
  },
]);
</script>

<template>
  <UPageHero
    :title="t('app.title')"
    :description="t('app.description')"
    :links="links"
  >
    <template #headline>
      <div class="flex w-full justify-center">
        <img
          src="/creup-site-header-logo-light.svg"
          alt="CREUP"
          class="h-12 w-auto sm:h-14 dark:hidden"
        />
        <img
          src="/creup-site-header-logo-dark.svg"
          alt="CREUP"
          class="hidden h-12 w-auto sm:h-14 dark:block"
        />
      </div>
    </template>
  </UPageHero>
</template>
