<script setup lang="ts">
/**
 * The «Tratado» box of a row in the lists: ticked when the row was treated.
 * It only shows the mark; the Mesa changes it in the row's panel
 * (ControlSheetRowPanel). `label` names the row ("Tratado: 3.1. Informe").
 * While a change made in the panel is on its way (`saving`) the box shows
 * the new value. It takes no clicks: one on it falls through to its row,
 * which opens that panel (E-086), instead of dying on a disabled box.
 */
defineProps<{
  treated: boolean;
  saving?: boolean;
  label: string;
}>();
</script>

<template>
  <span class="pointer-events-none inline-flex items-center">
    <UCheckbox
      :model-value="treated"
      disabled
      :aria-label="label"
      :aria-busy="saving || undefined"
    />
  </span>
</template>
