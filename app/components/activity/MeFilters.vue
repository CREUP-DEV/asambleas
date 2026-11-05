<script setup lang="ts">
import type { AssemblySummaryDto } from "~~/shared/types/api";
import {
  ME_ACTIVITY_TAB_CATEGORIES,
  meActivityHasFilters,
  meActivityTabHasAssemblies,
  type MeActivityFilters,
} from "~/composables/activity/-filters";
import { ACTIVITY_CATEGORY_ICONS } from "~/composables/activity/-present";

/**
 * Filters of "Mi actividad": the assembly (tabs about assemblies), what
 * kind of thing (the categories the tab can show) and a range of days.
 * Each change replaces the whole filter set (the page keeps it in the URL).
 */
const props = defineProps<{
  assemblies: AssemblySummaryDto[];
  assembliesLoading?: boolean;
}>();

const filters = defineModel<MeActivityFilters>({ required: true });

const { t } = useI18n();
const { categoryLabel } = useActivityText();

/** Sentinel for "every assembly / every kind" in the selects. */
const ALL = "__all__";

function patch(change: Partial<MeActivityFilters>): void {
  filters.value = { ...filters.value, ...change };
}

const showAssembly = computed(() =>
  meActivityTabHasAssemblies(filters.value.tab),
);
const categories = computed(
  () => ME_ACTIVITY_TAB_CATEGORIES[filters.value.tab],
);

const assemblyItems = computed(() => {
  const items = props.assemblies.map((assembly) => ({
    label: assembly.label,
    value: assembly.slug,
  }));
  const current = filters.value.assembly;
  // The URL's assembly before the list arrives, or one no longer listed.
  if (current && !items.some((item) => item.value === current)) {
    items.unshift({ label: current, value: current });
  }
  return [{ label: t("activity.filters.allAssemblies"), value: ALL }, ...items];
});

const categoryItems = computed(() => [
  {
    label: t("activity.filters.allCategories"),
    value: ALL,
    icon: "i-lucide-layers",
  },
  ...categories.value.map((category) => ({
    label: categoryLabel(category),
    value: category,
    icon: ACTIVITY_CATEGORY_ICONS[category],
  })),
]);

const assemblyValue = computed({
  get: () => filters.value.assembly ?? ALL,
  set: (value: string) => patch({ assembly: value === ALL ? null : value }),
});

const categoryValue = computed({
  get: () => filters.value.category ?? ALL,
  set: (value: string) =>
    patch({
      category:
        value === ALL
          ? null
          : (categories.value.find((category) => category === value) ?? null),
    }),
});

const hasFilters = computed(() => meActivityHasFilters(filters.value));

function clear(): void {
  patch({ assembly: null, category: null, from: null, to: null });
}
</script>

<template>
  <div
    class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end"
  >
    <UFormField v-if="showAssembly" :label="t('activity.filters.assembly')">
      <USelectMenu
        v-model="assemblyValue"
        :items="assemblyItems"
        value-key="value"
        :loading="props.assembliesLoading"
        :search-input="labelledSearch(t('activity.filters.searchAssembly'))"
        :aria-label="
          selectMenuLabel(
            t('activity.filters.assembly'),
            assemblyItems,
            assemblyValue,
          )
        "
        class="w-full"
      />
    </UFormField>

    <UFormField
      v-if="categories.length > 0"
      :label="t('activity.filters.category')"
    >
      <USelect v-model="categoryValue" :items="categoryItems" class="w-full" />
    </UFormField>

    <UFormField :label="t('activity.filters.from')">
      <ActivityDayInput
        :model-value="filters.from"
        :label="t('activity.filters.from')"
        :max="filters.to"
        @update:model-value="patch({ from: $event })"
      />
    </UFormField>

    <UFormField :label="t('activity.filters.to')">
      <ActivityDayInput
        :model-value="filters.to"
        :label="t('activity.filters.to')"
        :min="filters.from"
        @update:model-value="patch({ to: $event })"
      />
    </UFormField>

    <div v-if="hasFilters" class="flex items-end">
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-filter-x"
        @click="clear"
      >
        {{ t("activity.filters.clear") }}
      </UButton>
    </div>
  </div>
</template>
