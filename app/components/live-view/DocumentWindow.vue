<script setup lang="ts">
import type {
  AmendmentDto,
  DocumentDto,
  LiveScrollAnchor,
  LiveScrollDto,
} from "~~/shared/types/api";
import {
  amendmentCodeIn,
  usePendingConciliation,
} from "~/composables/document/pendingConciliation";
import {
  contentPages,
  documentPagesTarget,
  useDocumentPages,
} from "~/composables/document/useDocumentPages";
import { applyScrollAnchor, readViewAnchor } from "~/utils/scrollAnchor";

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
 *
 * With `live` false it is a plain preview of any document (the control
 * sheet's «Vista previa», user's decision of 2026-11-19): `description`
 * says what it is, nothing follows the Mesa, and each document starts at
 * its top, keeping the reader's place while it is closed and opened again.
 * It shows a document only while it is the one asked for (`requestedId`):
 * the last one never stands in for the next while it loads or when it
 * could not be loaded (`failed`).
 */
const props = withDefaults(
  defineProps<{
    /** The document in debate, null when the Mesa shows none. */
    document: DocumentDto | null;
    /**
     * The Mesa put another document on screen and it is on its way: the
     * window shows a skeleton rather than the last one meanwhile.
     */
    loading?: boolean;
    /** Where the Mesa has it scrolled, the latest the page heard. */
    scroll: LiveScrollDto | null;
    /** Localized path of the document's page. */
    documentPath: string | null;
    /** The document on screen, followed (the live view); false: a preview. */
    live?: boolean;
    /** What the window says under its title when it is not `live`. */
    description?: string;
    /**
     * Not `live`: the document asked for, null when none is (closed); the
     * window shows no other.
     */
    requestedId?: string | null;
    /** Not `live`: the document asked for could not be loaded. */
    failed?: boolean;
    /**
     * The document's amendments the reader reads: a passage approved
     * pending conciliation names their codes (user's decisions of
     * 2026-11-21); without them it says only that it is pending.
     */
    amendments?: readonly Pick<AmendmentDto, "id" | "code" | "number">[];
  }>(),
  {
    loading: false,
    live: true,
    description: undefined,
    requestedId: null,
    failed: false,
    amendments: undefined,
  },
);

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
/**
 * The document asked for, kept while the window closes (as `path`), so the
 * closing window still shows the one it had.
 */
const requested = ref(props.requestedId);
watch(
  () => props.requestedId,
  (value) => {
    if (value) requested.value = value;
  },
);
/** What the window shows: `shown`, unless a preview asked for another. */
const current = computed(() =>
  props.live || !requested.value || shown.value?.id === requested.value
    ? shown.value
    : null,
);
const onScreen = computed(
  () => Boolean(props.document) && props.document?.id === shown.value?.id,
);

/** The text as the projection shows it: voted, or as published. */
const blocks = computed(
  () =>
    current.value?.consolidatedVersion?.blocks ??
    current.value?.baseVersion?.blocks ??
    [],
);
const isFile = computed(() => current.value?.format === "file");
/** Passages approved pending conciliation, marked in the text. */
const { marks: pendingMarksOf } = usePendingConciliation();
const pendingMarks = computed(() =>
  pendingMarksOf(
    current.value?.consolidatedVersion,
    props.amendments ? amendmentCodeIn(props.amendments) : undefined,
  ),
);

// «pág. N» as the package's PDF of the text shown prints it (user's
// decisions of 2026-11-21): the consolidated one once voted. Read only
// while the window is open: it follows whatever the Mesa projects, for
// the whole room.
const { assembly } = useCurrentAssembly();
const { pages: pdfPages } = useDocumentPages(() =>
  !open.value || isFile.value
    ? null
    : documentPagesTarget(assembly.value?.id, current.value),
);
const textPages = computed(() =>
  current.value?.consolidatedVersion
    ? contentPages(
        pdfPages.value?.consolidated,
        current.value.consolidatedVersion,
      )
    : contentPages(pdfPages.value?.base, current.value?.baseVersion),
);
const textPageTotal = computed(
  () =>
    (current.value?.consolidatedVersion
      ? pdfPages.value?.consolidated?.total
      : pdfPages.value?.base?.total) ?? 0,
);
const textPage = ref<number | null>(null);

/**
 * Following the Mesa, or left where the reader scrolled (`readerAnchor`,
 * kept while the window is closed).
 */
const following = ref(true);
const readerAnchor = ref<LiveScrollAnchor | null>(null);

const content = ref<HTMLElement | null>(null);
/**
 * The box that scrolls the text: a region of its own that takes the focus
 * when the window opens, so the keys move the text at once (Safari never
 * focuses a scrolling box by itself).
 */
const box = ref<HTMLElement | null>(null);
const modalContent = {
  onOpenAutoFocus: (event: Event) => {
    if (!box.value) return;
    event.preventDefault();
    // Where it scrolls to is place()'s to say.
    box.value.focus({ preventScroll: true });
  },
};

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

// Opening, another document, or the text back after the skeleton: placed once
// laid out (a PDF once its pages have their size, `ready`, which also comes
// after a resize).
watch(
  [open, () => shown.value?.id, box, content],
  async ([isOpen, id, element, text]) => {
    if (!isOpen || !id || !element || !text || isFile.value) return;
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
  <!--
    On a phone the window takes the whole screen. While the document is on
    screen the footer says so («Sigue la proyección» or «Ir a lo
    proyectado»): the description only says when it no longer is.
  -->
  <UModal
    v-model:open="open"
    :title="current?.title ?? t('liveView.document.view')"
    :description="
      !live ? description : onScreen ? undefined : t('liveView.document.gone')
    "
    :content="modalContent"
    :ui="{
      content:
        'max-w-4xl h-[calc(100dvh-2rem)] sm:h-[calc(100dvh-4rem)] max-h-none max-sm:inset-0 max-sm:h-dvh max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:shadow-none max-sm:ring-0',
      body: 'flex min-h-0 flex-col overflow-hidden p-0 sm:p-0',
      footer: 'flex flex-wrap items-center gap-2',
    }"
  >
    <template #body>
      <div
        ref="box"
        role="region"
        tabindex="0"
        :aria-label="current?.title ?? t('liveView.document.view')"
        class="min-h-0 flex-1 overflow-y-auto p-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:p-5"
      >
        <CommonDocumentSkeleton v-if="loading" />
        <UAlert
          v-else-if="failed"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('liveView.document.loadError')"
        />
        <div v-else-if="current" ref="content" class="relative">
          <template v-if="isFile">
            <DocumentPdfPages
              v-if="current.fileUrl"
              :key="current.id"
              :url="current.fileUrl"
              :title="current.title"
              @ready="place"
            />
            <p v-else class="text-muted">
              {{ t("projection.pdfPending") }}
            </p>
          </template>
          <div v-else-if="blocks.length > 0" :key="current.id" class="live-doc">
            <ContentView
              :blocks="blocks"
              :pending="pendingMarks"
              :pages="textPages"
              @page="textPage = $event"
            />
          </div>
          <p v-else class="text-muted">
            {{ t("liveView.document.empty") }}
          </p>
        </div>
      </div>
    </template>

    <template #footer>
      <!-- The PDF page being read. -->
      <ContentPageIndicator
        v-if="textPages"
        :page="textPage"
        :total="textPageTotal"
      />
      <template v-if="live && onScreen">
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
      <!-- On a phone only its arrow, so the footer keeps to one row. -->
      <UButton
        v-if="path"
        :to="path"
        color="neutral"
        variant="outline"
        size="lg"
        class="ms-auto"
        trailing-icon="i-lucide-arrow-right"
      >
        <span class="max-sm:sr-only">
          {{ t("liveView.document.openPage") }}
        </span>
      </UButton>
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
