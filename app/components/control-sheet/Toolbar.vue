<script
  setup
  lang="ts"
  generic="K extends string, V extends string, E extends string"
>
import type { SheetSort } from "./-filters";

/**
 * Filters and order of one list of the control sheet, kept quiet: a few
 * chips (role=group, aria-pressed), a search box, a «Filtros» popover for
 * the result, and, below large screens where the table's headers are not
 * shown, the column to sort by and its direction (the same state the
 * headers set). When the order is by a column of states (a result, an
 * answer), at every size, which of them goes first («Primero»). The page keeps it all in the query; `status` is what the
 * polite live region says after a change («Ordenado por Resultado,
 * ascendente · 12 de 30 puntos»), `count` what shows while filtering.
 */
const props = defineProps<{
  searchLabel: string;
  searchPlaceholder: string;
  views: readonly { value: V; label: string }[];
  viewsLabel: string;
  extraItems: readonly { value: E; label: string }[];
  extraLabel: string;
  sortItems: readonly { value: K; label: string }[];
  fallback: SheetSort<K>;
  /**
   * The states of the column the list is sorted by, any of which may go
   * first; empty for a column without states.
   */
  leadItems?: readonly { value: string; label: string }[];
  /** Filters in use, the search included. */
  active: number;
  count: string | null;
  status: string;
}>();
const search = defineModel<string>("search", { required: true });
const view = defineModel<V>("view", { required: true });
const extra = defineModel<E[]>("extra", { required: true });
const sort = defineModel<SheetSort<K>>("sort", { required: true });
const emit = defineEmits<{ clear: [] }>();

const { t } = useI18n();

// The menus take plain strings: the values are only ever the items given.
const sortKey = computed<string>({
  get: () => sort.value.key,
  set: (value) => {
    const key = props.sortItems.find((item) => item.value === value)?.value;
    if (!key || key === sort.value.key) return;
    sort.value = { key, dir: "asc" };
  },
});
const extraValues = computed<string[]>({
  get: () => extra.value,
  set: (values) => {
    extra.value = props.extraItems
      .map((item) => item.value)
      .filter((value) => values.includes(value));
  },
});
const sortLabel = computed(
  () =>
    props.sortItems.find((item) => item.value === sort.value.key)?.label ?? "",
);
const otherDir = computed(() => (sort.value.dir === "asc" ? "desc" : "asc"));

function flipDir(): void {
  sort.value = { key: sort.value.key, dir: otherDir.value };
}

const sortSelectItems = computed<{ value: string; label: string }[]>(() =>
  props.sortItems.map((item) => ({ value: item.value, label: item.label })),
);
/** «Primero»: the column's own order, or one of its states first. */
const COLUMN_ORDER = "__column__";
const leadSelectItems = computed<{ value: string; label: string }[]>(() => [
  { value: COLUMN_ORDER, label: t("controlSheet.sort.leadNone") },
  ...(props.leadItems ?? []).map((item) => ({
    value: item.value,
    label: item.label,
  })),
]);
const leadValue = computed<string>({
  get: () => sort.value.lead ?? COLUMN_ORDER,
  set: (value) => {
    const lead = (props.leadItems ?? []).some((item) => item.value === value)
      ? value
      : null;
    if (lead === (sort.value.lead ?? null)) return;
    sort.value = { key: sort.value.key, dir: sort.value.dir, lead };
  },
});

const extraSelectItems = computed<{ value: string; label: string }[]>(() =>
  props.extraItems.map((item) => ({ value: item.value, label: item.label })),
);
</script>

<template>
  <div class="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
    <!-- Without the sheet's marks there is nothing to choose: no chips. -->
    <div
      v-if="views.length > 0"
      class="flex flex-wrap items-center gap-1.5"
      role="group"
      :aria-label="viewsLabel"
    >
      <UButton
        v-for="entry in views"
        :key="entry.value"
        size="sm"
        :color="view === entry.value ? 'primary' : 'neutral'"
        :variant="view === entry.value ? 'subtle' : 'outline'"
        :aria-pressed="view === entry.value"
        :label="entry.label"
        @click="view = entry.value"
      />
    </div>

    <div class="flex flex-1 flex-wrap items-center gap-2" role="search">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        size="sm"
        type="search"
        class="min-w-48 flex-1 sm:max-w-sm"
        :placeholder="searchPlaceholder"
        :aria-label="searchLabel"
      />
      <UPopover :content="{ align: 'start' }">
        <UButton
          icon="i-lucide-list-filter"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('controlSheet.filters.button')"
          :aria-label="
            extra.length > 0
              ? t('controlSheet.filters.buttonActive', { count: extra.length })
              : t('controlSheet.filters.button')
          "
        >
          <template v-if="extra.length > 0" #trailing>
            <UBadge size="xs" color="primary" :label="String(extra.length)" />
          </template>
        </UButton>
        <template #content>
          <div class="flex w-72 max-w-[90vw] flex-col gap-3 p-3">
            <UFormField :label="extraLabel">
              <USelectMenu
                v-model="extraValues"
                :items="extraSelectItems"
                value-key="value"
                multiple
                :search-input="false"
                class="w-full"
                :placeholder="t('controlSheet.filters.any')"
                :aria-label="
                  selectMenuLabel(
                    extraLabel,
                    extraSelectItems,
                    extra,
                    t('controlSheet.filters.any'),
                  )
                "
              />
            </UFormField>
          </div>
        </template>
      </UPopover>

      <!-- Below large screens the table's headers are not there. -->
      <div class="flex items-center gap-1 lg:hidden">
        <USelect
          v-model="sortKey"
          :items="sortSelectItems"
          value-key="value"
          size="sm"
          class="w-44"
          :aria-label="t('controlSheet.sort.label')"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :icon="
            sort.dir === 'asc'
              ? 'i-lucide-arrow-up-narrow-wide'
              : 'i-lucide-arrow-down-wide-narrow'
          "
          :aria-label="
            t('controlSheet.sort.by', {
              column: sortLabel,
              direction: t(`controlSheet.sort.${otherDir}`),
            })
          "
          @click="flipDir"
        />
      </div>

      <!-- Which state of the sorted column goes first, at every size. -->
      <div
        v-if="leadItems && leadItems.length > 0"
        class="flex items-center gap-1.5"
      >
        <span class="text-muted text-sm" aria-hidden="true">{{
          t("controlSheet.sort.leadPrefix")
        }}</span>
        <USelect
          v-model="leadValue"
          :items="leadSelectItems"
          value-key="value"
          size="sm"
          class="w-52"
          :aria-label="t('controlSheet.sort.lead', { column: sortLabel })"
        />
      </div>

      <UButton
        v-if="active > 0"
        icon="i-lucide-filter-x"
        color="neutral"
        variant="ghost"
        size="sm"
        :label="t('controlSheet.filters.clear')"
        @click="emit('clear')"
      />
      <span v-if="count" class="text-muted text-sm tabular-nums">
        {{ count }}
      </span>
    </div>

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ status }}
    </p>
  </div>
</template>
