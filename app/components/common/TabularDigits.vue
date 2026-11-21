<script setup lang="ts">
import { digitCells, TABULAR_DIGIT_EM } from "~/components/common/-digits";

/**
 * A number that ticks (a clock, a live count) with every digit in a cell of
 * the same width, so it never changes width from one tick to the next:
 * Raleway has no tabular figures, so `tabular-nums` alone does nothing
 * (see -digits.ts). The text inherits its size, weight and colour. Screen
 * readers read the text once, not the cells one by one.
 */
const props = defineProps<{ text: string }>();

const cells = computed(() => digitCells(props.text));
const cellStyle = { width: `${TABULAR_DIGIT_EM}em` };
</script>

<template>
  <span class="whitespace-nowrap tabular-nums"
    ><span class="sr-only">{{ text }}</span
    ><span aria-hidden="true"
      ><template v-for="(cell, index) in cells" :key="index"
        ><span
          v-if="cell.digit"
          class="inline-block text-center"
          :style="cellStyle"
          >{{ cell.char }}</span
        ><template v-else>{{ cell.char }}</template></template
      ></span
    ></span
  >
</template>
