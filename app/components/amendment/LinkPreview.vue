<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";

/**
 * The preview of another amendment a code link opens when clicked
 * (AmendmentCodeLinks): its code, who presents it, where it
 * stands, and what it changes, only the blocks it touches, in a box that
 * scrolls; «Ver la enmienda» opens it.
 */
defineProps<{
  amendment: AmendmentDto;
  label: string;
  /** The document's text; without it, no diff. */
  base: Block[] | null;
  canOpen: boolean;
}>();

const emit = defineEmits<{ open: [] }>();

const { t } = useI18n();
</script>

<template>
  <div class="w-[min(32rem,90vw)] space-y-2 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-highlighted font-semibold tabular-nums">
        {{ label }}
      </span>
      <CommonMemberBadge
        v-for="author in amendment.authors"
        :key="author.id"
        :member="author"
        :tooltip="false"
      />
      <CommonStatusBadge
        v-if="amendment.status !== 'submitted'"
        kind="amendment"
        :value="amendment.status"
      />
    </div>
    <div
      v-if="base"
      class="border-default max-h-64 overflow-y-auto rounded-md border p-2 text-sm"
    >
      <ContentAmendmentDiff
        :id="amendment.id"
        :base="base"
        :ops="amendment.ops"
        :context="0"
      />
    </div>
    <UButton
      v-if="canOpen"
      color="neutral"
      variant="outline"
      size="xs"
      icon="i-lucide-arrow-right"
      :label="t('amendment.links.open')"
      @click="emit('open')"
    />
  </div>
</template>
