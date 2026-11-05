<script setup lang="ts">
/**
 * "Cargar más" under an activity list, plus a polite live region that says
 * how many items each click added. The button stays where it is, so
 * keyboard focus does not jump; once everything is loaded it says so.
 */
const props = withDefaults(
  defineProps<{
    hasMore: boolean;
    loading?: boolean;
    /** The sentence of the last load ("Se han cargado 20 más"). */
    announcement?: string;
    /** Items shown, for "Eso es todo" under a non-empty list. */
    count?: number;
  }>(),
  { loading: false, announcement: "", count: 0 },
);

const emit = defineEmits<{ load: [] }>();

const { t } = useI18n();
</script>

<template>
  <div class="flex flex-col items-center gap-2 pt-2">
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ props.announcement }}
    </p>
    <UButton
      v-if="props.hasMore"
      color="neutral"
      variant="outline"
      icon="i-lucide-chevrons-down"
      :loading="props.loading"
      class="w-full justify-center sm:w-auto"
      @click="emit('load')"
    >
      {{ t("activity.list.loadMore") }}
    </UButton>
    <p v-else-if="props.count > 0" class="text-dimmed text-xs">
      {{ t("activity.list.end") }}
    </p>
  </div>
</template>
