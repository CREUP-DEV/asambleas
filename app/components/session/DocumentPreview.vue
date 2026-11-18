<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";
import { useApi } from "~/composables/api/useApi";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { readScrollAnchor } from "~/utils/scrollAnchor";

/**
 * The text of the document the console shows, for the Mesa to follow what
 * the room reads when it takes no amendments: its uploaded PDF drawn page
 * by page (DocumentPdfPages), else its text as voted or, before, as
 * published. An amendable text is read in «Texto consolidado», with its
 * amendments applied.
 *
 * While it is the document on screen and the session is open, where the
 * Mesa scrolls it is where the projection shows it (user's decision of
 * 2026-11-18): each scroll sends the block or page at the top
 * (readScrollAnchor) to POST .../live-scroll, at most every
 * SCROLL_SEND_MS, the last one always.
 */
const props = defineProps<{ document: DocumentDto }>();

const { t } = useI18n();
const api = useApi();
const session = useSessionConsoleContext();

const SCROLL_SEND_MS = 150;

const blocks = computed(
  () =>
    props.document.consolidatedVersion?.blocks ??
    props.document.baseVersion?.blocks ??
    [],
);

const box = ref<HTMLElement | null>(null);
const isFile = computed(() => props.document.format === "file");
/** The projection follows only the document the room debates. */
const follows = computed(
  () =>
    session.inSession.value &&
    session.liveState.value?.documentId === props.document.id,
);

let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = 0;
function send(): void {
  timer = undefined;
  const element = box.value;
  if (!element || !follows.value) return;
  const anchor = readScrollAnchor(element, isFile.value ? "page" : "block");
  if (!anchor) return;
  lastSent = Date.now();
  const id = session.assembly.value?.id;
  if (!id) return;
  void api
    .send(`/api/assemblies/${encodeURIComponent(id)}/live-scroll`, {
      method: "POST",
      body: { documentId: props.document.id, anchor },
    })
    .catch(() => undefined);
}
function onScroll(): void {
  if (!follows.value || timer) return;
  const wait = Math.max(0, SCROLL_SEND_MS - (Date.now() - lastSent));
  timer = setTimeout(send, wait);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <section
    class="space-y-2"
    :aria-label="t('session.queue.documentText', { title: document.title })"
  >
    <template v-if="isFile">
      <div
        v-if="document.fileUrl"
        ref="box"
        class="border-default bg-elevated max-h-[min(70vh,48rem)] overflow-y-auto rounded-lg border p-3"
        @scroll.passive="onScroll"
      >
        <DocumentPdfPages
          :key="document.id"
          :url="document.fileUrl"
          :title="document.title"
        />
      </div>
      <p v-else class="text-muted text-sm">
        {{ t("session.queue.pdfPending") }}
      </p>
    </template>
    <div
      v-else-if="blocks.length > 0"
      ref="box"
      class="border-default bg-default max-h-[32rem] overflow-y-auto rounded-lg border p-4"
      @scroll.passive="onScroll"
    >
      <ContentView :key="document.id" :blocks="blocks" />
    </div>
    <p v-else class="text-muted text-sm">{{ t("session.preview.empty") }}</p>
  </section>
</template>
