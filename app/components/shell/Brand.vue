<script setup lang="ts">
/** CREUP brand in the sidebar header: full logo, or the app icon when collapsed. */
const props = defineProps<{ collapsed?: boolean }>();

const { t } = useI18n();
const localePath = useLocalePath();
</script>

<template>
  <NuxtLink
    :to="localePath('/')"
    class="focus-visible:outline-primary flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
    :class="props.collapsed ? 'mx-auto' : ''"
    :aria-label="t('shell.brand.home')"
  >
    <img
      v-if="props.collapsed"
      src="/favicon.svg"
      alt=""
      class="size-8 shrink-0"
      width="32"
      height="32"
    />
    <template v-else>
      <img
        src="/creup-site-header-logo-light.svg"
        alt=""
        class="h-7 w-auto shrink-0 dark:hidden"
        width="126"
        height="28"
      />
      <img
        src="/creup-site-header-logo-dark.svg"
        alt=""
        class="hidden h-7 w-auto shrink-0 dark:block"
        width="126"
        height="28"
      />
      <span
        class="border-default text-muted truncate border-s ps-2.5 text-xs font-semibold tracking-wide uppercase"
      >
        {{ t("shell.brand.product") }}
      </span>
    </template>
  </NuxtLink>
</template>
