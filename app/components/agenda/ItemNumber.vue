<script setup lang="ts">
/**
 * The number of an agenda item ("3.1.") as every screen shows it. Everyone
 * reads the same number for the same item, so an item that is not in the
 * agenda for everyone yet (`number` null: the sub-item of a document that is
 * not public, or one whose title is withheld after its document was deleted)
 * has none: it shows a short neutral mark in its place, with the reason on
 * hover. The hint covers both cases: the first gets a number when its
 * document is published, the second has no document and gets one when a
 * manager gives it a new title. The classes given go to the number; the mark
 * takes the colour and the size of the text around it, never a status colour.
 */
defineOptions({ inheritAttrs: false });

defineProps<{
  number: string | null;
}>();

const { t } = useI18n();
</script>

<template>
  <span v-if="number" v-bind="$attrs" class="tabular-nums">{{ number }}.</span>
  <span
    v-else
    class="me-2 inline-block rounded-sm border border-current/30 px-1.5 align-middle text-[0.75em] leading-normal font-normal whitespace-nowrap opacity-80"
    :title="t('agenda.unlisted.hint')"
    data-testid="agenda-unlisted"
    >{{ t("agenda.unlisted.label") }}</span
  >
</template>
