<script setup lang="ts">
import {
  AMENDMENT_KINDS,
  AMENDMENT_STATUSES,
  type AmendmentStatus,
} from "~~/shared/constants/domain";
import type { MemberRef } from "~~/shared/types/api";
import {
  activeAmendmentFilterCount,
  AMENDMENT_QUICK_FILTERS,
  AMENDMENT_REVIEW_FILTERS,
  amendmentQuickFilterOf,
  applyAmendmentQuickFilter,
  emptyAmendmentFilters,
  type AmendmentFilters,
  type AmendmentLateFilter,
  type AmendmentQuickFilter,
  type AmendmentReviewFilter,
} from "~/composables/amendment/workspace";

/**
 * What the amendments panel lists, as visible chips: "Todas", "Pendientes"
 * and "Fuera de plazo" set the filters (applyAmendmentQuickFilter), and
 * "Mías" switches to the actor's own amendments (`tab`: drafts,
 * corrections and where the rest stand), with how many wait for them.
 *
 * Under them, for the whole list only: the search box and "Más filtros", a
 * popover with the rest (where it stands, where it stands with the
 * Secretaría when the actor sees amendments that are not public, with
 * "Devueltas para corregir" only when some were sent back and the actor
 * cannot edit them, kind, who presents it, on time or late, and "only
 * mine"). A block filter set from the text gutter shows as a removable
 * chip.
 *
 * Each chip carries `data-amendment-chip`, so the page can give focus back
 * to the pressed one.
 */
const props = withDefaults(
  defineProps<{
    authorOptions: MemberRef[];
    /** Offer "only mine" (the actor acts for a member). */
    canFilterMine?: boolean;
    /** Offer the review filter (some listed amendments are not public). */
    showReviewFilter?: boolean;
    /** Offer "Devueltas para corregir" (the actor sees some it cannot edit). */
    showReturnedFilter?: boolean;
    /** Human reference of the filtered block ("¶ 3"). */
    blockLabel?: string | null;
    /** Offer "Mías" (the actor can amend, or presents some amendment). */
    showMine?: boolean;
    /** How many of the actor's own amendments wait for them. */
    mineWaiting?: number;
    /** Some of those are corrections the Secretaría asked for. */
    mineUrgent?: boolean;
    /** How many amendments the whole list holds. */
    total?: number | null;
  }>(),
  {
    canFilterMine: false,
    showReviewFilter: false,
    showReturnedFilter: false,
    blockLabel: null,
    showMine: false,
    mineWaiting: 0,
    mineUrgent: false,
    total: null,
  },
);

const filters = defineModel<AmendmentFilters>({ required: true });
/** The whole list, or the actor's own amendments. */
const tab = defineModel<"all" | "mine">("tab", { default: "all" });

const { t } = useI18n();

function patch(change: Partial<AmendmentFilters>): void {
  filters.value = { ...filters.value, ...change };
}

const statusItems = computed(() =>
  AMENDMENT_STATUSES.filter((status) => status !== "draft").map(
    (status): { label: string; value: AmendmentStatus } => ({
      label: t(`common.status.amendment.${status}`),
      value: status,
    }),
  ),
);
const kindItems = computed(() =>
  AMENDMENT_KINDS.map((kind) => ({
    label: t(`amendment.kinds.${kind}`),
    value: kind,
  })),
);
const memberItems = computed(() => props.authorOptions.map(memberMenuItem));
const reviewItems = computed(() =>
  AMENDMENT_REVIEW_FILTERS.filter((value) => {
    if (filters.value.review === value || value === "any") return true;
    if (value === "correction_requested") return props.showReturnedFilter;
    // Only the returned ones to show: the other states would list nothing.
    return props.showReviewFilter;
  }).map((value) => ({
    label: t(`amendment.filters.reviewOptions.${value}`),
    value,
  })),
);
const lateItems = computed(() =>
  (["any", "late", "on_time"] as AmendmentLateFilter[]).map((value) => ({
    label: t(`amendment.filters.lateOptions.${value}`),
    value,
  })),
);

const showingMine = computed(() => props.showMine && tab.value === "mine");
/** The chip the filters amount to; none while "Mías" is on. */
const quick = computed(() =>
  showingMine.value ? null : amendmentQuickFilterOf(filters.value),
);

function pick(value: AmendmentQuickFilter): void {
  tab.value = "all";
  filters.value = applyAmendmentQuickFilter(filters.value, value);
}

/**
 * Filters set in the popover (search and block chip are outside), leaving
 * out what the pressed chip already says.
 */
const popoverCount = computed(() =>
  activeAmendmentFilterCount({
    ...filters.value,
    query: "",
    blockId: null,
    ...(quick.value === "pending" ? { statuses: [] } : {}),
    ...(quick.value === "late" ? { late: "any" as const } : {}),
  }),
);
const anyActive = computed(() => activeAmendmentFilterCount(filters.value) > 0);

function clearAll(): void {
  filters.value = emptyAmendmentFilters();
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="group"
      :aria-label="t('amendment.filters.chipsLabel')"
    >
      <UButton
        v-for="value in AMENDMENT_QUICK_FILTERS"
        :key="value"
        size="sm"
        :color="quick === value ? 'primary' : 'neutral'"
        :variant="quick === value ? 'subtle' : 'outline'"
        :aria-pressed="quick === value"
        data-amendment-chip
        @click="pick(value)"
      >
        {{ t(`amendment.filters.chips.${value}`) }}
        <span
          v-if="value === 'all' && total !== null"
          class="text-muted tabular-nums"
        >
          {{ total }}
        </span>
      </UButton>
      <UButton
        v-if="showMine"
        size="sm"
        :color="showingMine ? 'primary' : 'neutral'"
        :variant="showingMine ? 'subtle' : 'outline'"
        :aria-pressed="showingMine"
        :aria-label="
          mineWaiting > 0
            ? t(
                'amendment.filters.chips.mineWaiting',
                { count: mineWaiting },
                mineWaiting,
              )
            : undefined
        "
        data-amendment-chip
        @click="tab = 'mine'"
      >
        {{ t("amendment.filters.chips.mine") }}
        <UBadge
          v-if="mineWaiting > 0"
          size="sm"
          :color="mineUrgent ? 'warning' : 'neutral'"
          variant="subtle"
          class="tabular-nums"
          :label="String(mineWaiting)"
          aria-hidden="true"
        />
      </UButton>
    </div>

    <div v-if="!showingMine" class="flex items-center gap-2">
      <UInput
        :model-value="filters.query"
        icon="i-lucide-search"
        size="sm"
        class="min-w-0 flex-1"
        :placeholder="t('amendment.filters.searchPlaceholder')"
        :aria-label="t('amendment.filters.search')"
        @update:model-value="patch({ query: String($event ?? '') })"
      />
      <UPopover :content="{ align: 'end' }">
        <UButton
          icon="i-lucide-list-filter"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('amendment.filters.button')"
          :aria-label="
            popoverCount > 0
              ? t('amendment.filters.buttonActive', { count: popoverCount })
              : t('amendment.filters.button')
          "
        >
          <template v-if="popoverCount > 0" #trailing>
            <UBadge size="xs" color="primary" :label="String(popoverCount)" />
          </template>
        </UButton>

        <template #content>
          <div class="flex w-80 max-w-[90vw] flex-col gap-3 p-3">
            <UFormField :label="t('amendment.filters.status')">
              <USelectMenu
                :model-value="filters.statuses"
                :items="statusItems"
                value-key="value"
                multiple
                :search-input="false"
                class="w-full"
                :placeholder="t('amendment.filters.any')"
                :aria-label="
                  selectMenuLabel(
                    t('amendment.filters.status'),
                    statusItems,
                    filters.statuses,
                    t('amendment.filters.any'),
                  )
                "
                @update:model-value="patch({ statuses: $event })"
              />
            </UFormField>
            <UFormField
              v-if="
                showReviewFilter ||
                showReturnedFilter ||
                filters.review !== 'any'
              "
              :label="t('amendment.filters.review')"
            >
              <USelect
                :model-value="filters.review"
                :items="reviewItems"
                class="w-full"
                @update:model-value="
                  patch({ review: $event as AmendmentReviewFilter })
                "
              />
            </UFormField>
            <UFormField :label="t('amendment.filters.kind')">
              <USelectMenu
                :model-value="filters.kinds"
                :items="kindItems"
                value-key="value"
                multiple
                :search-input="false"
                class="w-full"
                :placeholder="t('amendment.filters.any')"
                :aria-label="
                  selectMenuLabel(
                    t('amendment.filters.kind'),
                    kindItems,
                    filters.kinds,
                    t('amendment.filters.any'),
                  )
                "
                @update:model-value="patch({ kinds: $event })"
              />
            </UFormField>
            <UFormField :label="t('amendment.filters.member')">
              <USelectMenu
                :model-value="filters.memberIds"
                :items="memberItems"
                value-key="value"
                :ui="MEMBER_MENU_UI"
                :filter-fields="MEMBER_MENU_FILTER_FIELDS"
                multiple
                class="w-full"
                :placeholder="t('amendment.filters.any')"
                :aria-label="
                  selectMenuLabel(
                    t('amendment.filters.member'),
                    memberItems,
                    filters.memberIds,
                    t('amendment.filters.any'),
                  )
                "
                :search-input="
                  labelledSearch(t('amendment.filters.memberSearch'))
                "
                @update:model-value="patch({ memberIds: $event })"
              />
            </UFormField>
            <UFormField :label="t('amendment.filters.late')">
              <USelect
                :model-value="filters.late"
                :items="lateItems"
                class="w-full"
                @update:model-value="
                  patch({ late: $event as AmendmentLateFilter })
                "
              />
            </UFormField>
            <USwitch
              v-if="canFilterMine"
              :model-value="filters.mine"
              :label="t('amendment.filters.mine')"
              @update:model-value="patch({ mine: Boolean($event) })"
            />
            <UButton
              v-if="anyActive"
              icon="i-lucide-filter-x"
              color="neutral"
              variant="ghost"
              size="sm"
              class="self-start"
              :label="t('amendment.filters.clear')"
              @click="clearAll"
            />
          </div>
        </template>
      </UPopover>
    </div>

    <div v-if="filters.blockId && !showingMine" class="flex items-center gap-2">
      <UBadge
        color="primary"
        variant="subtle"
        icon="i-lucide-pilcrow"
        :label="
          blockLabel
            ? t('amendment.filters.blockNamed', { block: blockLabel })
            : t('amendment.filters.block')
        "
      />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="t('amendment.filters.removeBlock')"
        @click="patch({ blockId: null })"
      />
    </div>
  </div>
</template>
