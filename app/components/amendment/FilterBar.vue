<script setup lang="ts">
import {
  AMENDMENT_KINDS,
  AMENDMENT_STATUSES,
  type AmendmentStatus,
} from "~~/shared/constants/domain";
import type { MemberRef } from "~~/shared/types/api";
import {
  activeAmendmentFilterCount,
  emptyAmendmentFilters,
  type AmendmentFilters,
  type AmendmentLateFilter,
} from "~/composables/amendment/workspace";

/**
 * Search box plus a popover with the amendment filters: status, kind,
 * presenting member, late or on time, and "only mine". A block filter set
 * from the text gutter shows as a removable chip.
 */
const props = withDefaults(
  defineProps<{
    authorOptions: MemberRef[];
    /** Offer "only mine" (the actor acts for a member). */
    canFilterMine?: boolean;
    /** Human reference of the filtered block ("¶ 3"). */
    blockLabel?: string | null;
  }>(),
  { canFilterMine: false, blockLabel: null },
);

const filters = defineModel<AmendmentFilters>({ required: true });

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
const memberItems = computed(() =>
  props.authorOptions.map((member) => ({
    label: `${member.acronym} · ${member.name}`,
    value: member.id,
  })),
);
const lateItems = computed(() =>
  (["any", "late", "on_time"] as AmendmentLateFilter[]).map((value) => ({
    label: t(`amendment.filters.lateOptions.${value}`),
    value,
  })),
);

/** Filters inside the popover (search and block chip are outside). */
const popoverCount = computed(() =>
  activeAmendmentFilterCount({
    ...filters.value,
    query: "",
    blockId: null,
  }),
);
const anyActive = computed(() => activeAmendmentFilterCount(filters.value) > 0);

function clearAll(): void {
  filters.value = emptyAmendmentFilters();
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
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
                @update:model-value="patch({ statuses: $event })"
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
                @update:model-value="patch({ kinds: $event })"
              />
            </UFormField>
            <UFormField :label="t('amendment.filters.member')">
              <USelectMenu
                :model-value="filters.memberIds"
                :items="memberItems"
                value-key="value"
                multiple
                class="w-full"
                :placeholder="t('amendment.filters.any')"
                :search-input="{
                  placeholder: t('amendment.filters.memberSearch'),
                }"
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

    <div v-if="filters.blockId" class="flex items-center gap-2">
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
