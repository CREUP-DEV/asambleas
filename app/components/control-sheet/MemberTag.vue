<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";
import { useTouchTapGuard } from "~/components/common/-memberBadge";

/**
 * A member in the control sheet: the coloured acronym tag used across the
 * platform (CommonMemberBadge, 12px) that opens its card as the «+N» list
 * shows it (ControlSheetMemberCardList) on hover, on a tap and on keyboard
 * focus. The tag is a plain tab stop, with no role nor `aria-haspopup`, so a
 * mouse click on it still opens the row's panel (`rowClickOpens`); a tap
 * opens only the card, its click stopping at the tag. Screen readers get the
 * full name and a council's university from the tag itself.
 */
defineProps<{
  member: MemberRef;
  members: ReadonlyMap<string, MemberDto>;
}>();

const tapGuard = useTouchTapGuard();
</script>

<template>
  <UPopover
    mode="hover"
    :open-delay="200"
    :close-delay="100"
    :enable-touch="true"
  >
    <CommonMemberBadge
      :member="member"
      :members="members"
      :tooltip="false"
      tabindex="0"
      class="focus-visible:outline-primary rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
      @pointerdown="tapGuard.pointerdown"
      @click="tapGuard.click"
    />
    <template #content>
      <ControlSheetMemberCardList :list="[member]" :members="members" />
    </template>
  </UPopover>
</template>
