<script setup lang="ts">
/**
 * Folds its content away and back, animating its height (`axis` y) or its
 * width (x) through the grid track (0fr to 1fr), so nothing has to be
 * measured. Only where the reader has not asked for reduced motion. Folded,
 * it is inert and hidden from assistive technology: nothing in it takes
 * the focus. Margins set from outside (`class`) are animated too, so one
 * that cancels a parent's gap can go with the fold.
 */
withDefaults(
  defineProps<{
    open: boolean;
    axis?: "x" | "y";
  }>(),
  { axis: "y" },
);
</script>

<template>
  <div
    class="grid motion-safe:duration-300 motion-safe:ease-out"
    :class="[
      axis === 'y'
        ? 'motion-safe:transition-[grid-template-rows,opacity,margin]'
        : 'motion-safe:transition-[grid-template-columns,opacity,margin]',
      open
        ? axis === 'y'
          ? 'grid-rows-[1fr] opacity-100'
          : 'grid-cols-[1fr] opacity-100'
        : axis === 'y'
          ? 'grid-rows-[0fr] opacity-0'
          : 'grid-cols-[0fr] opacity-0',
    ]"
    :inert="!open || undefined"
    :aria-hidden="!open || undefined"
  >
    <div
      :class="
        axis === 'y' ? 'min-h-0 overflow-hidden' : 'min-w-0 overflow-hidden'
      "
    >
      <slot />
    </div>
  </div>
</template>
