<script setup lang="ts">
import type { SheetSpeaker } from "~~/shared/utils/controlSheet";

/**
 * «Intervinientes» of a row: who spoke, each member (or person) once, in
 * the order they first spoke, never how many times (user's decision of
 * 2026-11-19). The names written down for a member open from its button,
 * so keyboards and touch screens reach them too, never only on hover.
 */
defineProps<{
  speakers: SheetSpeaker[];
}>();

const { t } = useI18n();
</script>

<template>
  <span v-if="speakers.length === 0" class="text-dimmed text-sm">{{
    t("controlSheet.speakers.none")
  }}</span>
  <ul
    v-else
    class="flex flex-wrap gap-1"
    :aria-label="t('controlSheet.columns.speakers')"
  >
    <li v-for="speaker in speakers" :key="speaker.label">
      <UPopover v-if="speaker.names.length > 0">
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          :label="speaker.label"
          :aria-label="
            t('controlSheet.speakers.names', { label: speaker.label })
          "
        />
        <template #content>
          <ul class="space-y-1 p-3 text-sm">
            <li v-for="name in speaker.names" :key="name">{{ name }}</li>
          </ul>
        </template>
      </UPopover>
      <UBadge
        v-else
        color="neutral"
        variant="soft"
        size="md"
        :label="speaker.label"
      />
    </li>
  </ul>
</template>
