<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";

/**
 * The content of every member popover in the control sheet, one tag's or
 * the «+N» list's, so both read alike: an optional heading, then each
 * member's card with its acronym tag (ControlSheetMemberCard). Hidden from
 * screen readers: the tag or the «+N» says the names itself.
 */
defineProps<{
  list: readonly MemberRef[];
  members: ReadonlyMap<string, MemberDto>;
  title?: string;
}>();
</script>

<template>
  <div class="w-max max-w-sm space-y-2 p-3" aria-hidden="true">
    <p v-if="title" class="text-muted text-xs font-medium">{{ title }}</p>
    <ul class="space-y-3">
      <li v-for="member in list" :key="member.id">
        <ControlSheetMemberCard :member="member" :members="members" tag />
      </li>
    </ul>
  </div>
</template>
