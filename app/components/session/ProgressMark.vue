<script setup lang="ts">
/**
 * Where a document stands in the session, as a quiet word with its icon:
 * «Proyectado» once the Mesa put it on screen, «Tratado» once its own
 * sub-item is marked treated (useSessionConsole's documentProgress).
 * Nothing before. The icon carries the colour; the word stays neutral.
 */
defineProps<{ progress: "treated" | "projected" | null }>();

const { t } = useI18n();
</script>

<template>
  <span
    v-if="progress"
    class="text-muted inline-flex items-center gap-1 text-xs"
    :data-progress="progress"
  >
    <UIcon
      :name="
        progress === 'treated' ? 'i-lucide-circle-check' : 'i-lucide-monitor'
      "
      class="size-3.5 shrink-0"
      :class="progress === 'treated' ? 'text-success' : 'text-info'"
      aria-hidden="true"
    />
    {{
      progress === "treated"
        ? t("session.progress.treated")
        : t("session.progress.projected")
    }}
  </span>
</template>
