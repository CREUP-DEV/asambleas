<script setup lang="ts">
import type {
  DocumentDto,
  LiveScrollAnchor,
  LiveScrollDto,
} from "~~/shared/types/api";
import {
  applyScrollAnchor,
  readViewAnchor,
  scrollParentOf,
} from "~/utils/scrollAnchor";

/**
 * The document on screen, read without leaving the live view (user's
 * decision of 2026-11-19): a floating window with its text, or its PDF
 * drawn page by page, that follows the part the Mesa has on screen (the
 * stream's `scroll`, as on the projection) until the reader scrolls it.
 * From then on it stays where the reader leaves it, closed and opened
 * again included, until «Ir a lo proyectado» puts it back on the Mesa's
 * part and following again. Another document on screen starts following
 * again; when the Mesa leaves the document, the window keeps it and says it
 * is no longer on screen.
 */
const props = defineProps<{
  /** The document in debate, null when the Mesa shows none. */
  document: DocumentDto | null;
  /** Where the Mesa has it scrolled, the latest the page heard. */
  scroll: LiveScrollDto | null;
  /** Localized path of the document's page. */
  documentPath: string | null;
}>();

const open = defineModel<boolean>("open", { required: true });

const { t } = useI18n();

/** The document shown: the one in debate, or the last one while none is. */
const shown = ref<DocumentDto | null>(props.document);
const path = ref(props.documentPath);
watch(
  () => props.document,
  (document) => {
    if (!document) return;
    if (document.id !== shown.value?.id) {
      following.value = true;
      readerAnchor.value = null;
    }
    shown.value = document;
  },
);
watch(
  () => props.documentPath,
  (value) => {
    if (value) path.value = value;
  },
);
const onScreen = computed(
  () => Boolean(props.document) && props.document?.id === shown.value?.id,
);

/** The text as the projection shows it: voted, or as published. */
const blocks = computed(
  () =>
    shown.value?.consolidatedVersion?.blocks ??
    shown.value?.baseVersion?.blocks ??
    [],
);
const isFile = computed(() => shown.value?.format === "file");

/**
 * Following the Mesa, or left where the reader scrolled (`readerAnchor`,
 * kept while the window is closed).
 */
const following = ref(true);
const readerAnchor = ref<LiveScrollAnchor | null>(null);

const content = ref<HTMLElement | null>(null);
const box = ref<HTMLElement | null>(null);
watch(
  content,
  (element) => {
    box.value = element ? scrollParentOf(element) : null;
  },
  { flush: "post" },
);

/** Puts the window where it should be: the Mesa's part, or the reader's. */
function place(): void {
  const target = box.value;
  if (!target) return;
  const anchor = following.value
    ? props.scroll?.documentId === shown.value?.id
      ? (props.scroll?.anchor ?? null)
      : null
    : readerAnchor.value;
  if (anchor && applyScrollAnchor(target, anchor)) return;
  if (following.value) target.scrollTo({ top: 0 });
}

/** «Ir a lo proyectado»: back to the Mesa's part, following it again. */
function goToProjected(): void {
  following.value = true;
  readerAnchor.value = null;
  place();
}

// The Mesa scrolls: the window goes with it while it follows.
watch(
  () => props.scroll,
  () => {
    if (open.value && following.value) place();
  },
);

// Opening, or another document: placed once laid out (a PDF once its pages
// have their size, `ready`, which also comes after a resize).
watch(
  [open, () => shown.value?.id, box],
  async ([isOpen, id, element]) => {
    if (!isOpen || !id || !element || isFile.value) return;
    await nextTick();
    requestAnimationFrame(place);
  },
  { flush: "post" },
);

// The reader moves the text: it stops following and stays there.
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);
function letGo(): void {
  following.value = false;
}
useEventListener(box, "wheel", letGo, { passive: true });
useEventListener(box, "touchmove", letGo, { passive: true });
useEventListener(box, "keydown", (event: KeyboardEvent) => {
  if (SCROLL_KEYS.has(event.key)) letGo();
});
// The scrollbar: a press on the scrolling box itself, not on its text.
useEventListener(box, "pointerdown", (event: PointerEvent) => {
  if (event.target === box.value) letGo();
});
useEventListener(
  box,
  "scroll",
  () => {
    if (following.value || !content.value || !box.value) return;
    readerAnchor.value = readViewAnchor(
      content.value,
      isFile.value ? "page" : "block",
      box.value.getBoundingClientRect().top,
    );
  },
  { passive: true },
);
</script>

<template>
  <UModal
    v-model:open="open"
    :title="shown?.title ?? t('liveView.document.view')"
    :description="
      onScreen ? t('liveView.document.onScreen') : t('liveView.document.gone')
    "
    :ui="{
      content:
        'max-w-4xl h-[calc(100dvh-2rem)] sm:h-[calc(100dvh-4rem)] max-h-none',
      body: 'p-3 sm:p-5',
      footer: 'flex flex-wrap items-center gap-2',
    }"
  >
    <template #body>
      <div v-if="shown" ref="content" class="relative">
        <template v-if="isFile">
          <DocumentPdfPages
            v-if="shown.fileUrl"
            :key="shown.id"
            :url="shown.fileUrl"
            :title="shown.title"
            @ready="place"
          />
          <p v-else class="text-muted">
            {{ t("projection.pdfPending") }}
          </p>
        </template>
        <div v-else-if="blocks.length > 0" :key="shown.id" class="live-doc">
          <ContentView :blocks="blocks" />
        </div>
        <p v-else class="text-muted">
          {{ t("liveView.document.empty") }}
        </p>
      </div>
    </template>

    <template #footer>
      <template v-if="onScreen">
        <p
          v-if="following"
          class="text-muted flex min-h-10 items-center gap-2 text-sm"
          role="status"
        >
          <span
            class="bg-success size-2 rounded-full motion-safe:animate-pulse"
            aria-hidden="true"
          />
          {{ t("liveView.document.following") }}
        </p>
        <UButton
          v-else
          icon="i-lucide-locate-fixed"
          size="lg"
          class="grow justify-center sm:grow-0"
          :label="t('liveView.document.goToProjected')"
          @click="goToProjected"
        />
      </template>
      <UButton
        v-if="path"
        :to="path"
        color="neutral"
        variant="outline"
        size="lg"
        class="grow justify-center sm:ms-auto sm:grow-0"
        trailing-icon="i-lucide-arrow-right"
        :label="t('liveView.document.openPage')"
      />
    </template>
  </UModal>
</template>

<style scoped>
/* Large enough to read on a phone, as the change in the debate card. */
.live-doc :deep(.rich-text) {
  font-size: 1.0625rem;
  line-height: 1.65;
}

@media (min-width: 640px) {
  .live-doc :deep(.rich-text) {
    font-size: 1.125rem;
  }
}
</style>
