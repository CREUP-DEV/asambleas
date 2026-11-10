<script setup lang="ts">
/**
 * What a USelectMenu shows once a value is chosen, for its default slot:
 * the item's `chosen` text when it has one (a member picker shows
 * "VGC · Vocalía de …" while its list shows the acronym above the name),
 * else its label, else the placeholder. Styled with the menu's own `ui`.
 */
const props = defineProps<{
  items: { value: string; label: string; chosen?: string }[];
  value: unknown;
  placeholder?: string;
  /** The `ui` the menu passes to its default slot. */
  ui: { value: () => string; placeholder: () => string };
}>();

const text = computed(() => {
  const item = props.items.find((candidate) => candidate.value === props.value);
  return item ? (item.chosen ?? item.label) : null;
});
</script>

<template>
  <span v-if="text" data-slot="value" :class="ui.value()">{{ text }}</span>
  <span v-else data-slot="placeholder" :class="ui.placeholder()">
    <template v-if="placeholder">{{ placeholder }}</template>
    <template v-else>&nbsp;</template>
  </span>
</template>
