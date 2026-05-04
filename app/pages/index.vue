<script setup lang="ts">
const { t } = useI18n();

useHead({
  title: t("app.title"),
});
</script>

<template>
  <div class="flex min-h-screen items-center justify-center">
    <div class="text-center">
      <h1 class="text-3xl font-bold text-primary">
        {{ t("app.title") }}
      </h1>
      <p class="mt-2 text-muted">
        {{ t("app.description") }}
      </p>
    </div>
  </div>
</template>
