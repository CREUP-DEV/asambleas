<script setup lang="ts" generic="K extends string">
import { nextSort, type SheetSort } from "./-filters";

/**
 * A column header of the control sheet's tables that sorts by its column:
 * `aria-sort` on the sorted column only, and a button named after the
 * column and what pressing it does («Ordenar por Resultado, descendente»,
 * «Quitar el orden por Resultado»), since a fixed «Ordenar por» never says
 * which way. Classes given to it go on the `<th>`.
 */
const props = defineProps<{
  label: string;
  column: K;
  sort: SheetSort<K>;
  /** The default order, where a third press goes back to. */
  fallback: SheetSort<K>;
}>();
const emit = defineEmits<{ sort: [column: K] }>();

const { t } = useI18n();

const sorted = computed(() => props.sort.key === props.column);
const ariaSort = computed(() => {
  if (!sorted.value) return undefined;
  return props.sort.dir === "asc" ? "ascending" : "descending";
});
const icon = computed(() => {
  if (!sorted.value) return "i-lucide-arrow-up-down";
  return props.sort.dir === "asc"
    ? "i-lucide-arrow-up-narrow-wide"
    : "i-lucide-arrow-down-wide-narrow";
});
const action = computed(() => {
  const next = nextSort(props.sort, props.column, props.fallback);
  if (next.key !== props.column) {
    return t("controlSheet.sort.reset", { column: props.label });
  }
  return t("controlSheet.sort.by", {
    column: props.label,
    direction: t(`controlSheet.sort.${next.dir}`),
  });
});
</script>

<template>
  <th scope="col" :aria-sort="ariaSort" class="px-3 py-2 font-medium">
    <button
      type="button"
      class="hover:text-default focus-visible:outline-primary -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-left focus-visible:outline-2"
      :class="sorted ? 'text-highlighted' : ''"
      :aria-label="action"
      @click="emit('sort', column)"
    >
      <span>{{ label }}</span>
      <UIcon
        :name="icon"
        :class="['size-3.5 shrink-0', sorted ? '' : 'text-dimmed']"
        aria-hidden="true"
      />
    </button>
  </th>
</template>
