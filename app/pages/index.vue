<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();

useHead({
  title: t("app.title"),
});
</script>

<template>
  <UContainer class="py-8">
    <div class="text-center">
      <h1 class="text-3xl font-bold text-primary">
        {{ t("app.title") }}
      </h1>
      <p class="mt-2 text-muted">
        {{ t("app.description") }}
      </p>
      <div class="mt-6">
        <UButton :to="localePath('/asambleas')" icon="i-tabler-gavel" size="lg">
          {{ t("nav.assemblies") }}
        </UButton>
      </div>
    </div>
  </UContainer>
</template>
