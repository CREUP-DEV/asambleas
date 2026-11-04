<script setup lang="ts">
import type { SessionAgendaRow } from "~/composables/session/sessionModel";

/**
 * The agenda as the projection shows it: large type, the current item
 * highlighted with the brand colour and marked as the current step.
 */
withDefaults(
  defineProps<{
    rows: SessionAgendaRow[];
    currentId: string | null;
    /** `full` for the idle screen, `compact` beside a document. */
    size?: "full" | "compact";
  }>(),
  { size: "full" },
);
</script>

<template>
  <ol
    :class="
      size === 'full' ? 'grid gap-x-8 gap-y-3 xl:grid-cols-2' : 'space-y-2'
    "
  >
    <li
      v-for="row in rows"
      :key="row.item.id"
      :style="{
        paddingInlineStart: `${row.depth * (size === 'full' ? 2 : 1.5) + 1}rem`,
      }"
      class="rounded-xl pe-4"
      :class="[
        size === 'full' ? 'py-3' : 'py-2 text-[clamp(1rem,1.3vw,1.5rem)]',
        row.item.id === currentId
          ? 'bg-primary text-inverted font-bold'
          : size === 'full'
            ? 'text-default'
            : 'text-muted',
      ]"
      :aria-current="row.item.id === currentId ? 'step' : undefined"
    >
      <span class="tabular-nums">{{ row.number }}.</span>
      {{ row.item.title }}
    </li>
  </ol>
</template>
