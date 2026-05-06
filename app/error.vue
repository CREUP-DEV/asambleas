<script setup lang="ts">
import type { NuxtError } from "#app";

const { t } = useI18n();
const localePath = useLocalePath();

const props = defineProps<{
  error: NuxtError;
}>();

const statusCode = computed(() => props.error.statusCode ?? 500);

const title = computed(() => {
  switch (statusCode.value) {
    case 404:
      return t("errors.notFound");
    case 403:
      return t("errors.forbidden");
    default:
      return t("errors.serverError");
  }
});

const handleError = () => clearError({ redirect: localePath("/") });
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="text-center">
      <p class="text-primary text-6xl font-bold">
        {{ statusCode }}
      </p>
      <h1 class="mt-4 text-2xl font-semibold">
        {{ title }}
      </h1>
      <p
        v-if="error.message && error.message !== title"
        class="text-muted mt-2"
      >
        {{ error.message }}
      </p>
      <UButton class="mt-8" size="lg" @click="handleError">
        {{ t("nav.home") }}
      </UButton>
    </div>
  </div>
</template>
