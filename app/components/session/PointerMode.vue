<script setup lang="ts">
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * On a text document, what the Mesa's pointer does with a drag: draw a
 * stroke, or select words, which the projection highlights on the same
 * words (session.pointerTools.mode). In the preview's tools and the bar
 * stuck on top alike.
 */
withDefaults(defineProps<{ size?: "xs" | "sm" }>(), { size: "sm" });

const session = useSessionConsoleContext();
const tools = session.pointerTools;
const { t } = useI18n();
</script>

<template>
  <UFieldGroup :size="size" :aria-label="t('session.pointer.modeLabel')">
    <UButton
      :color="tools.mode === 'draw' ? 'primary' : 'neutral'"
      :variant="tools.mode === 'draw' ? 'soft' : 'outline'"
      icon="i-lucide-pen-line"
      :label="t('session.pointer.draw')"
      :aria-pressed="tools.mode === 'draw'"
      @click="tools.mode = 'draw'"
    />
    <UButton
      :color="tools.mode === 'select' ? 'primary' : 'neutral'"
      :variant="tools.mode === 'select' ? 'soft' : 'outline'"
      icon="i-lucide-text-cursor"
      :label="t('session.pointer.select')"
      :aria-pressed="tools.mode === 'select'"
      @click="tools.mode = 'select'"
    />
  </UFieldGroup>
</template>
