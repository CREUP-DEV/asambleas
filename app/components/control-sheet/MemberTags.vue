<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";

/**
 * Who presents something in the control sheet: the main presenters as
 * tags with their card (ControlSheetMemberTag), then «+N» for the rest,
 * listed with their full names when the pointer is over it. Screen readers
 * read the names of the rest from the «+N» itself.
 */
const props = defineProps<{
  main: MemberRef[];
  others: MemberRef[];
  /** Every member by id, for the cards. */
  members: ReadonlyMap<string, MemberDto>;
}>();

const { t } = useI18n();

const othersText = computed(() =>
  t(
    "controlSheet.morePresenters",
    {
      count: props.others.length,
      names: props.others.map((member) => member.name).join(", "),
    },
    props.others.length,
  ),
);
</script>

<template>
  <ul
    v-if="main.length + others.length > 0"
    class="flex flex-wrap items-center gap-1 text-sm"
    :aria-label="t('controlSheet.columns.proponent')"
  >
    <li v-for="member in main" :key="member.id" class="flex items-center">
      <ControlSheetMemberTag :member="member" :members="members" />
    </li>
    <li v-if="others.length > 0" class="flex items-center">
      <UPopover mode="hover" :open-delay="200" :close-delay="100">
        <UBadge color="neutral" variant="outline" size="sm">
          <span aria-hidden="true">+{{ others.length }}</span>
          <span class="sr-only">{{ othersText }}</span>
        </UBadge>
        <template #content>
          <div class="max-w-xs space-y-2 p-3" aria-hidden="true">
            <p class="text-muted text-xs font-medium">
              {{ t("controlSheet.otherPresenters") }}
            </p>
            <ul class="space-y-1.5">
              <li v-for="member in others" :key="member.id">
                <CommonMemberBadge :member="member" size="sm" show-name />
              </li>
            </ul>
          </div>
        </template>
      </UPopover>
    </li>
  </ul>
</template>
