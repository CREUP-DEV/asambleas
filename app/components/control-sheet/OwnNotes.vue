<script setup lang="ts">
import type { OwnNoteLine } from "./-readers";

/**
 * «Mis notas» in a row of the control sheet, for a reader without the
 * sheet's key to edit (user's decision of 2026-11-21): the account's latest
 * general private note on the document (one per document, named, on an
 * item with several) or on the amendment, clamped, with «y N más» when
 * there are others. Read only: they are written in the row's panel. Nothing
 * written reads as nothing, said only to screen readers.
 */
defineProps<{
  lines: OwnNoteLine[];
  /** Lines per note before it is cut. */
  clamp?: 2 | 3 | 4;
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="lines.length > 0" class="min-w-0 space-y-1">
    <div v-for="(line, index) in lines" :key="index" class="min-w-0">
      <p v-if="line.label" class="text-muted truncate text-xs">
        {{ line.label }}
      </p>
      <p
        :class="[
          'text-default text-sm break-words whitespace-pre-line',
          clamp === 2
            ? 'line-clamp-2'
            : clamp === 4
              ? 'line-clamp-4'
              : 'line-clamp-3',
        ]"
      >
        {{ line.body }}
      </p>
      <p v-if="line.more > 0" class="text-muted text-xs">
        {{ t("controlSheet.ownNotes.more", { count: line.more }, line.more) }}
      </p>
    </div>
  </div>
  <span v-else class="sr-only">{{ t("controlSheet.ownNotes.none") }}</span>
</template>
