<script setup lang="ts" generic="K extends string, V extends string">
import { isDefaultSort, type SheetSort, type SortDir } from "./-filters";

/** One list of «Filtros»: what it filters by and what is chosen in it. */
export interface SheetFilterGroup {
  key: string;
  label: string;
  items: readonly { value: string; label: string }[];
  /** Empty: any. */
  selected: readonly string[];
}

/**
 * Filters and order of one list of the control sheet (user's decision of
 * 2026-11-19), the same at every size:
 * - a few chips (role=group, aria-pressed) and the search box;
 * - «Filtros», a popover with a list per thing to filter by (`groups`);
 *   what is chosen shows under the bar as labels that each take it away;
 * - «Ordenar», a popover with the order, its direction and, for a column of
 *   states, which goes first («Primero»), named after the order in use; the
 *   table's headers set the same state;
 * - «Restablecer», back to the default order without filters.
 * The page keeps it all in the query; `status` is what the polite live
 * region says after a change, `count` what shows while filtering.
 */
const props = defineProps<{
  searchLabel: string;
  searchPlaceholder: string;
  views: readonly { value: V; label: string }[];
  viewsLabel: string;
  groups: readonly SheetFilterGroup[];
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
const sort = defineModel<SheetSort<K>>("sort", { required: true });
const emit = defineEmits<{
  /** A list of «Filtros» changed: its key and what is chosen now. */
  filter: [key: string, values: string[]];
  /** Back to the default order, without filters. */
  reset: [];
}>();

const { t } = useI18n();

// Filters ---------------------------------------------------------------------

const chosen = computed(() =>
  props.groups.reduce((total, group) => total + group.selected.length, 0),
);

/** What is chosen, one label each, to take it away from under the bar. */
const chips = computed(() =>
  props.groups.flatMap((group) =>
    group.selected.map((value) => ({
      id: `${group.key}:${value}`,
      group,
      value,
      label: `${group.label}: ${
        group.items.find((item) => item.value === value)?.label ?? value
      }`,
    })),
  ),
);

function setGroup(group: SheetFilterGroup, values: string[]): void {
  // In the order the list gives, so one choice always reads the same.
  const kept = group.items
    .map((item) => item.value)
    .filter((value) => values.includes(value));
  emit("filter", group.key, kept);
}

function removeChip(group: SheetFilterGroup, value: string): void {
  setGroup(
    group,
    group.selected.filter((entry) => entry !== value),
  );
}

// Order -----------------------------------------------------------------------

const sortLabel = computed(
  () =>
    props.sortItems.find((item) => item.value === sort.value.key)?.label ?? "",
);
const leadLabel = computed(() =>
  sort.value.lead
    ? (props.leadItems?.find((item) => item.value === sort.value.lead)?.label ??
      null)
    : null,
);
/** «Orden: Resultado · Rechazada primero», the button's own name. */
const sortButtonLabel = computed(() =>
  [
    t("controlSheet.sort.button", { column: sortLabel.value }),
    leadLabel.value
      ? t("controlSheet.sort.leadStatus", { state: leadLabel.value })
      : null,
  ]
    .filter(Boolean)
    .join(" · "),
);

// The menus take plain strings: the values are only ever the items given.
const sortKey = computed<string>({
  get: () => sort.value.key,
  set: (value) => {
    const key = props.sortItems.find((item) => item.value === value)?.value;
    if (!key || key === sort.value.key) return;
    sort.value = { key, dir: "asc" };
  },
});
const sortSelectItems = computed<{ value: string; label: string }[]>(() =>
  props.sortItems.map((item) => ({ value: item.value, label: item.label })),
);

function setDir(dir: SortDir): void {
  if (dir === sort.value.dir) return;
  sort.value = { ...sort.value, dir };
}

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

const changed = computed(
  () => props.active > 0 || !isDefaultSort(sort.value, props.fallback),
);
</script>

<template>
  <div class="flex flex-col gap-2">
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

        <UPopover v-if="groups.length > 0" :content="{ align: 'start' }">
          <UButton
            icon="i-lucide-list-filter"
            color="neutral"
            variant="outline"
            size="sm"
            :label="t('controlSheet.filters.button')"
            :aria-label="
              chosen > 0
                ? t('controlSheet.filters.buttonActive', { count: chosen })
                : t('controlSheet.filters.button')
            "
          >
            <template v-if="chosen > 0" #trailing>
              <UBadge size="xs" color="primary" :label="String(chosen)" />
            </template>
          </UButton>
          <template #content>
            <div class="flex w-80 max-w-[90vw] flex-col gap-3 p-3">
              <UFormField
                v-for="group in groups"
                :key="group.key"
                :label="group.label"
              >
                <USelectMenu
                  :model-value="[...group.selected]"
                  :items="[...group.items]"
                  value-key="value"
                  multiple
                  :search-input="group.items.length > 8"
                  class="w-full"
                  :placeholder="t('controlSheet.filters.any')"
                  :aria-label="
                    selectMenuLabel(
                      group.label,
                      group.items,
                      group.selected,
                      t('controlSheet.filters.any'),
                    )
                  "
                  @update:model-value="
                    (values: string[]) => setGroup(group, values)
                  "
                />
              </UFormField>
            </div>
          </template>
        </UPopover>

        <UPopover :content="{ align: 'start' }">
          <UButton
            icon="i-lucide-arrow-down-up"
            color="neutral"
            variant="outline"
            size="sm"
            class="max-w-full"
            :label="sortButtonLabel"
          />
          <template #content>
            <div class="flex w-72 max-w-[90vw] flex-col gap-3 p-3">
              <UFormField :label="t('controlSheet.sort.label')">
                <USelect
                  v-model="sortKey"
                  :items="sortSelectItems"
                  value-key="value"
                  class="w-full"
                />
              </UFormField>
              <div
                role="group"
                :aria-label="t('controlSheet.sort.direction')"
                class="flex gap-1.5"
              >
                <UButton
                  v-for="dir in ['asc', 'desc'] as const"
                  :key="dir"
                  size="sm"
                  :color="sort.dir === dir ? 'primary' : 'neutral'"
                  :variant="sort.dir === dir ? 'subtle' : 'outline'"
                  :aria-pressed="sort.dir === dir"
                  :icon="
                    dir === 'asc'
                      ? 'i-lucide-arrow-up-narrow-wide'
                      : 'i-lucide-arrow-down-wide-narrow'
                  "
                  :label="t(`controlSheet.sort.${dir}Label`)"
                  @click="setDir(dir)"
                />
              </div>
              <!-- A column of states: which of them goes first. -->
              <UFormField
                v-if="leadItems && leadItems.length > 0"
                :label="t('controlSheet.sort.leadField')"
                :description="t('controlSheet.sort.leadHint')"
              >
                <USelect
                  v-model="leadValue"
                  :items="leadSelectItems"
                  value-key="value"
                  class="w-full"
                  :aria-label="
                    t('controlSheet.sort.lead', { column: sortLabel })
                  "
                />
              </UFormField>
            </div>
          </template>
        </UPopover>

        <UButton
          v-if="changed"
          icon="i-lucide-rotate-ccw"
          color="neutral"
          variant="ghost"
          size="sm"
          :label="t('controlSheet.filters.reset')"
          @click="emit('reset')"
        />
        <span v-if="count" class="text-muted text-sm tabular-nums">
          {{ count }}
        </span>
        <!-- What acts on the list as shown (the download). -->
        <slot name="actions" />
      </div>
    </div>

    <!-- What filters the list, each one taken away on its own. -->
    <ul
      v-if="chips.length > 0"
      class="flex flex-wrap items-center gap-1.5"
      :aria-label="t('controlSheet.filters.inUse')"
    >
      <li v-for="chip in chips" :key="chip.id">
        <UButton
          size="xs"
          color="primary"
          variant="soft"
          trailing-icon="i-lucide-x"
          :label="chip.label"
          :aria-label="t('controlSheet.filters.remove', { filter: chip.label })"
          @click="removeChip(chip.group, chip.value)"
        />
      </li>
    </ul>

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ status }}
    </p>
  </div>
</template>
