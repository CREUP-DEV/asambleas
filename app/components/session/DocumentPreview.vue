<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";

/**
 * The text of the document the console shows, for the Mesa to follow what
 * the room reads when it takes no amendments: its uploaded PDF in the
 * browser's own viewer (DocumentPdfViewer: a card with the button on
 * phones; no "open in a new tab" above it), else its text as voted or,
 * before, as published. An amendable
 * text is read in «Texto consolidado», with its amendments applied.
 */
const props = defineProps<{ document: DocumentDto }>();

const { t } = useI18n();

const blocks = computed(
  () =>
    props.document.consolidatedVersion?.blocks ??
    props.document.baseVersion?.blocks ??
    [],
);
</script>

<template>
  <section
    class="space-y-2"
    :aria-label="t('session.queue.documentText', { title: document.title })"
  >
    <!-- The frame needs a height of its own inside the console's panel. -->
    <div v-if="document.format === 'file'" class="session-pdf">
      <DocumentPdfViewer
        :key="document.id"
        :url="document.fileUrl"
        :title="document.title"
        :open-button="false"
        :pending-description="t('session.queue.pdfPending')"
      />
    </div>
    <div
      v-else-if="blocks.length > 0"
      class="border-default bg-default max-h-[32rem] overflow-y-auto rounded-lg border p-4"
    >
      <ContentView :key="document.id" :blocks="blocks" />
    </div>
    <p v-else class="text-muted text-sm">{{ t("session.preview.empty") }}</p>
  </section>
</template>

<style scoped>
.session-pdf :deep(iframe) {
  height: min(70vh, 48rem);
}
</style>
