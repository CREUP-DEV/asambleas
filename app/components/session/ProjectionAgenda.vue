<script setup lang="ts">
import type { SessionAgendaRow } from "~/composables/session/sessionModel";

/**
 * The agenda as the projection shows it: large type, the current item
 * highlighted with the brand colour and marked as the current step.
 *
 * Each top-level item keeps its sub-items under it: on wide screens the
 * agenda flows in two columns, top to bottom, and an item never splits
 * from its sub-items.
 */
const props = withDefaults(
  defineProps<{
    rows: SessionAgendaRow[];
    currentId: string | null;
    /** `full` for the idle screen, `compact` beside a document. */
    size?: "full" | "compact";
  }>(),
  { size: "full" },
);

/** Each top-level item with the rows under it (the rows come depth-first). */
const groups = computed(() => {
  const result: { head: SessionAgendaRow; children: SessionAgendaRow[] }[] = [];
  for (const row of props.rows) {
    const last = result.at(-1);
    if (row.depth === 0 || !last) result.push({ head: row, children: [] });
    else last.children.push(row);
  }
  return result;
});

function rowStyle(row: SessionAgendaRow) {
  return {
    paddingInlineStart: `${row.depth * (props.size === "full" ? 2 : 1.5) + 1}rem`,
  };
}

function rowClass(row: SessionAgendaRow): string[] {
  return [
    "rounded-xl pe-4",
    props.size === "full" ? "py-3" : "py-2 text-[clamp(1rem,1.3vw,1.5rem)]",
    row.item.id === props.currentId
      ? "bg-primary text-inverted font-bold"
      : props.size === "full"
        ? "text-default"
        : "text-muted",
  ];
}
</script>

<template>
  <ol :class="size === 'full' ? 'gap-x-8 xl:columns-2' : 'space-y-2'">
    <li
      v-for="group in groups"
      :key="group.head.item.id"
      class="break-inside-avoid"
      :class="size === 'full' ? 'mb-3' : ''"
    >
      <div
        :style="rowStyle(group.head)"
        :class="rowClass(group.head)"
        :aria-current="group.head.item.id === currentId ? 'step' : undefined"
      >
        <span class="tabular-nums">{{ group.head.number }}.</span>
        {{ group.head.item.title }}
      </div>
      <ol
        v-if="group.children.length > 0"
        :class="size === 'full' ? 'mt-3 space-y-3' : 'mt-2 space-y-2'"
      >
        <li
          v-for="row in group.children"
          :key="row.item.id"
          :style="rowStyle(row)"
          :class="rowClass(row)"
          :aria-current="row.item.id === currentId ? 'step' : undefined"
        >
          <span class="tabular-nums">{{ row.number }}.</span>
          {{ row.item.title }}
        </li>
      </ol>
    </li>
  </ol>
</template>
