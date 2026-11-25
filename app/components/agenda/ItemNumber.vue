<script setup lang="ts">
/**
 * The number of an agenda item ("3.1.") as every screen shows it. Everyone
 * reads the same number for the same item, so an item that is not in the
 * agenda for everyone yet (`number` null: the sub-item of a document that is
 * not public, or one whose title is withheld after its document was deleted)
 * has none: it shows a short neutral mark in its place, with the reason on
 * hover and, for screen readers, as its description (a `hidden` text the
 * mark points to with `aria-describedby`, which still resolves hidden
 * targets). Hidden, not `sr-only`: the mark sits inside row links and
 * headings, and visually hidden text would join their accessible name, so
 * each would read the whole sentence before its title. The hint covers both
 * cases: the first gets a number when its
 * document is published, the second has no document and gets one when a
 * manager gives it a new title. The classes given go to the number; the mark
 * takes the colour and the size of the text around it, never a status colour.
 */
defineOptions({ inheritAttrs: false });

defineProps<{
  number: string | null;
}>();

const { t } = useI18n();
const hintId = useId();
</script>

<template>
  <span v-if="number" v-bind="$attrs" class="tabular-nums">{{ number }}.</span>
  <template v-else>
    <span
      class="me-2 inline-block rounded-sm border border-current/30 px-1.5 align-middle text-[0.75em] leading-normal font-normal whitespace-nowrap opacity-80"
      :title="t('agenda.unlisted.hint')"
      :aria-describedby="hintId"
      data-testid="agenda-unlisted"
      >{{ t("agenda.unlisted.label") }}</span
    ><span :id="hintId" hidden>{{ t("agenda.unlisted.hint") }}</span>
  </template>
</template>
