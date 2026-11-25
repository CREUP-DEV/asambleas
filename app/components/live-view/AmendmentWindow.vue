<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";
import {
  liveAmendmentCode,
  liveAmendmentNote,
  type LiveAmendmentRow,
} from "~/components/live-view/-model";

/**
 * An amendment of the document in debate, read without leaving the live
 * view (user's decision of 2026-11-19): a floating window with what
 * LiveViewAmendmentSummary says of it, its justification whole, the
 * previous and next amendment in the list's order, and the way to open it
 * in the document. It follows the live data: an amendment the list no
 * longer has closes it.
 */
const props = withDefaults(
  defineProps<{
    /** The document's amendments, in the list's order. */
    rows: LiveAmendmentRow[];
    document: DocumentDto | null;
    /** The room may see the main presenter's answers. */
    showPosition?: boolean;
    /** Localized path of the document workspace. */
    documentPath: string | null;
    /**
     * Every amendment of the document, for the note under the badge
     * («Sustituida por T1») when `rows` is a filtered list (the control
     * sheet's preview pages through the rows it shows); `rows` otherwise.
     */
    noteRows?: LiveAmendmentRow[];
    /**
     * `document` is on its way (the control sheet's preview fetches it on
     * opening): a skeleton rather than the amendment against no text.
     */
    loading?: boolean;
    /** `document` could not be loaded. */
    failed?: boolean;
  }>(),
  { showPosition: false, noteRows: undefined, loading: false, failed: false },
);

/** The amendment shown; null when closed. */
const amendmentId = defineModel<string | null>("amendmentId", {
  required: true,
});

const { t } = useI18n();

const index = computed(() =>
  props.rows.findIndex((row) => row.amendment.id === amendmentId.value),
);
const row = computed(() => props.rows[index.value] ?? null);
const previous = computed(() => props.rows[index.value - 1] ?? null);
const next = computed(() => props.rows[index.value + 1] ?? null);

const open = computed({
  get: () => Boolean(row.value),
  set: (value) => {
    if (!value) amendmentId.value = null;
  },
});

const note = computed(() => {
  if (!row.value) return null;
  const found = liveAmendmentNote(row.value, props.noteRows ?? props.rows);
  return found ? t(found.key, found.params ?? {}) : null;
});

const link = computed(() =>
  row.value && props.documentPath
    ? `${props.documentPath}?enmienda=${encodeURIComponent(row.value.amendment.id)}`
    : null,
);

/**
 * The box that scrolls the amendment: a region of its own that takes the
 * focus when the window opens, so the keys move it at once.
 */
const box = ref<HTMLElement | null>(null);

/** Each amendment starts at its top. */
watch(amendmentId, async () => {
  await nextTick();
  box.value?.scrollTo({ top: 0 });
});

function go(target: LiveAmendmentRow | null): void {
  if (target) amendmentId.value = target.amendment.id;
}

/**
 * ← and → page through the amendments anywhere in the window, but on a
 * link or a field, and never with a modifier (Alt+← goes back a page).
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  // A control inside that takes the arrows itself (tabs, radios…) keeps them.
  if (event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  if (
    target?.closest(
      "a, input, textarea, select, [contenteditable]:not([contenteditable='false']), [role=tab], [role=radio], [role=slider], [role=menuitem], [role=option]",
    )
  ) {
    return;
  }
  const destination = event.key === "ArrowRight" ? next.value : previous.value;
  if (!destination) return;
  event.preventDefault();
  go(destination);
}

const modalContent = {
  onOpenAutoFocus: (event: Event) => {
    if (!box.value) return;
    event.preventDefault();
    box.value.focus({ preventScroll: true });
  },
  onKeydown,
};
</script>

<template>
  <UModal
    v-model:open="open"
    :title="document?.title ?? t('liveView.amendmentWindow.title')"
    :description="
      row
        ? t('liveView.amendmentWindow.position', {
            index: index + 1,
            total: rows.length,
          })
        : undefined
    "
    :content="modalContent"
    :ui="{
      content: 'max-w-3xl',
      body: 'flex min-h-0 flex-col overflow-hidden p-0 sm:p-0',
      footer: 'flex flex-wrap items-center gap-2',
    }"
  >
    <template #body>
      <div
        ref="box"
        role="region"
        tabindex="0"
        :aria-label="
          (row && liveAmendmentCode(row.amendment)) ||
          t('liveView.amendmentWindow.title')
        "
        class="min-h-0 flex-auto overflow-y-auto p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:p-6"
      >
        <template v-if="row">
          <CommonDocumentSkeleton v-if="loading" />
          <UAlert
            v-else-if="failed"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('liveView.document.loadError')"
          />
          <LiveViewAmendmentSummary
            v-else
            :amendment="row.amendment"
            :document="document"
            :state="row.state"
            :note="note"
            :show-position="showPosition"
            heading-level="h2"
          />
        </template>
      </div>
    </template>

    <!--
      At the first or the last amendment its arrow stays focusable
      (aria-disabled), so the focus never drops out of the window.
    -->
    <template #footer>
      <UButton
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="outline"
        size="lg"
        :aria-disabled="previous ? undefined : 'true'"
        :aria-label="t('liveView.amendmentWindow.previous')"
        @click="go(previous)"
      />
      <UButton
        icon="i-lucide-chevron-right"
        color="neutral"
        variant="outline"
        size="lg"
        :aria-disabled="next ? undefined : 'true'"
        :aria-label="t('liveView.amendmentWindow.next')"
        @click="go(next)"
      />
      <UButton
        v-if="link"
        :to="link"
        color="neutral"
        variant="outline"
        size="lg"
        class="ms-auto"
        trailing-icon="i-lucide-arrow-right"
        :label="t('liveView.amendmentWindow.open')"
      />
    </template>
  </UModal>
</template>
