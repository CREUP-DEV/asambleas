<script setup lang="ts">
/**
 * The «Tratado» box of a row in the lists: ticked when the row was treated.
 * It only shows the mark; the Mesa changes it in the row's panel
 * (ControlSheetRowPanel). `label` names the row ("Tratado: 3.1. Informe").
 * While a change made in the panel is on its way (`saving`) the box shows
 * the new value.
 */
defineProps<{
  treated: boolean;
  saving?: boolean;
  label: string;
}>();
</script>

<template>
  <span class="inline-flex items-center">
    <UCheckbox
      :model-value="treated"
      disabled
      :aria-label="label"
      :aria-busy="saving || undefined"
    />
  </span>
</template>
