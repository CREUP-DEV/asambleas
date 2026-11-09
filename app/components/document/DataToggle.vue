<script setup lang="ts">
/**
 * Shows or hides the document's data beside its text (the Secretaría's
 * editor). A dot, and the button's name, say when the hidden data has
 * unsaved changes.
 */
withDefaults(defineProps<{ dirty?: boolean }>(), { dirty: false });

const open = defineModel<boolean>("open", { required: true });

const { t } = useI18n();
</script>

<template>
  <UChip :show="dirty && !open" color="warning" size="lg">
    <UButton
      color="neutral"
      variant="outline"
      :icon="open ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'"
      :label="t('document.metadata.heading')"
      :aria-expanded="open"
      aria-controls="document-data-panel"
      :aria-label="
        dirty && !open
          ? `${t('document.metadata.heading')}. ${t('document.metadata.unsavedHint')}`
          : undefined
      "
      @click="open = !open"
    />
  </UChip>
</template>
