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
import { statusLabelKey } from "~/utils/statusColors";

/**
 * What the amendments panel lists, in one row to keep the list tall: the
 * search box (whole list only) and a «Filtros» button named after what is
 * on show («Contenido», «Mías»...), with how many more filters are in use
 * and how many of the actor's own wait for them. It opens a popover with
 * the chips first: "Contenido" (what the list opens on) and "Forma", each
 * with how many there are, "Todas", "Pendientes", "Sin leer" (with how many
 * are left, only while the account has some or the filter is on) and
 * "Fuera de plazo" set the filters (applyAmendmentQuickFilter), and "Mías"
 * switches to the actor's own amendments (`tab`: drafts, corrections and
 * where the rest stand). Under them, for the whole list: where it stands,
 * where it stands with the Secretaría when the actor sees amendments that
 * are not public, with "Devueltas para corregir" only when some were sent
 * back and the actor cannot edit them, kind, who presents it, on time or
 * late, and "only mine". A block filter set from the text gutter shows as a
 * removable chip.
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
    /** How many of them are content and how many "de forma". */
    kindTotals?: { content: number; formal: number } | null;
    /** How many of them the account still has to read. */
    unread?: number;
    /** How many of them are withdrawn (only who reads them gets any). */
    withdrawn?: number;
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
    kindTotals: null,
    unread: 0,
    withdrawn: 0,
  },
);

/** The count a chip shows next to its name, if any. */
function chipCount(value: AmendmentQuickFilter): number | null {
  if (value === "all") return props.total;
  if (value === "content" || value === "formal") {
    return props.kindTotals?.[value] ?? null;
  }
  if (value === "unread") return props.unread > 0 ? props.unread : null;
  if (value === "withdrawn") return props.withdrawn;
  return null;
}

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
      label: t(statusLabelKey("amendment", status)),
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

/**
 * "Sin leer" only while something is left, and "Retiradas" only while some
 * are listed, or while either is on.
 */
const quickFilters = computed(() =>
  AMENDMENT_QUICK_FILTERS.filter((value) => {
    if (value === "unread") return props.unread > 0 || filters.value.unread;
    if (value === "withdrawn") {
      return props.withdrawn > 0 || quick.value === "withdrawn";
    }
    return true;
  }),
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
    ...(quick.value === "pending" || quick.value === "withdrawn"
      ? { statuses: [] }
      : {}),
    ...(quick.value === "late" ? { late: "any" as const } : {}),
    ...(quick.value === "unread" ? { unread: false } : {}),
    ...(quick.value === "content" || quick.value === "formal"
      ? { kinds: [] }
      : {}),
  }),
);
const anyActive = computed(() => activeAmendmentFilterCount(filters.value) > 0);

/** What the button says is on show: the chip, «Mías», or «Filtros». */
const buttonLabel = computed(() => {
  if (showingMine.value) return t("amendment.filters.chips.mine");
  return quick.value
    ? t(`amendment.filters.chips.${quick.value}`)
    : t("amendment.filters.button");
});

/** The button's name for screen readers, with the filters in use. */
const buttonAria = computed(() =>
  popoverCount.value > 0
    ? `${buttonLabel.value}. ${t("amendment.filters.buttonActive", {
        count: popoverCount.value,
      })}`
    : buttonLabel.value,
);

function clearAll(): void {
  filters.value = emptyAmendmentFilters();
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <UInput
        v-if="!showingMine"
        :model-value="filters.query"
        icon="i-lucide-search"
        class="min-w-0 flex-1"
        :ui="{ base: 'max-sm:h-10' }"
        :placeholder="t('common.search')"
        :aria-label="t('amendment.filters.search')"
        @update:model-value="patch({ query: String($event ?? '') })"
      />
      <UPopover :content="{ align: 'end', collisionPadding: 12 }">
        <UButton
          icon="i-lucide-list-filter"
          color="neutral"
          variant="outline"
          class="max-sm:h-10"
          :label="buttonLabel"
          :aria-label="buttonAria"
        >
          <template v-if="popoverCount > 0 || mineWaiting > 0" #trailing>
            <UBadge
              v-if="popoverCount > 0"
              size="xs"
              color="primary"
              :label="String(popoverCount)"
            />
            <UBadge
              v-if="mineWaiting > 0 && !showingMine"
              size="xs"
              :color="mineUrgent ? 'warning' : 'neutral'"
              variant="subtle"
              icon="i-lucide-user-round"
              :label="String(mineWaiting)"
            />
          </template>
        </UButton>

        <template #content>
          <div
            class="flex max-h-[calc(var(--reka-popover-content-available-height,70dvh)-0.5rem)] w-80 max-w-[90vw] flex-col gap-3 overflow-y-auto p-3"
          >
            <div
              class="flex flex-wrap items-center gap-1.5"
              role="group"
              :aria-label="t('amendment.filters.chipsLabel')"
            >
              <UButton
                v-for="value in quickFilters"
                :key="value"
                size="sm"
                :color="quick === value ? 'primary' : 'neutral'"
                :variant="quick === value ? 'subtle' : 'outline'"
                :aria-pressed="quick === value"
                :data-testid="`amendment-chip-${value}`"
                data-amendment-chip
                @click="pick(value)"
              >
                {{ t(`amendment.filters.chips.${value}`) }}
                <span
                  v-if="chipCount(value) !== null"
                  class="text-muted tabular-nums"
                >
                  {{ chipCount(value) }}
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

            <template v-if="!showingMine">
              <USeparator />
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
            </template>
          </div>
        </template>
      </UPopover>
    </div>

    <!-- A long passage name wraps beside its button, never cut (M-057). -->
    <div v-if="filters.blockId && !showingMine" class="flex items-start gap-2">
      <UBadge
        color="primary"
        variant="subtle"
        icon="i-lucide-pilcrow"
        class="min-w-0"
        :ui="{ label: 'text-clip whitespace-normal break-words text-start' }"
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
        size="md"
        class="shrink-0"
        :aria-label="t('amendment.filters.removeBlock')"
        @click="patch({ blockId: null })"
      />
    </div>
  </div>
</template>
