<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";

/**
 * A member in the control sheet: the coloured acronym tag used across the
 * platform (CommonMemberBadge) that opens, on hover, its card as the
 * «+N» list shows it (ControlSheetMemberCardList). Screen readers get the
 * full name from the tag itself.
 */
defineProps<{
  member: MemberRef;
  members: ReadonlyMap<string, MemberDto>;
}>();
</script>

<template>
  <UPopover mode="hover" :open-delay="200" :close-delay="100">
    <CommonMemberBadge :member="member" size="sm" :tooltip="false" />
    <template #content>
      <ControlSheetMemberCardList :list="[member]" :members="members" />
    </template>
  </UPopover>
</template>
