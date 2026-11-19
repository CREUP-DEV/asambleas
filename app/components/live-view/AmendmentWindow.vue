<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";
import {
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
  }>(),
  { showPosition: false },
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
  const found = liveAmendmentNote(row.value, props.rows);
  return found ? t(found.key, found.params ?? {}) : null;
});

const link = computed(() =>
  row.value && props.documentPath
    ? `${props.documentPath}?enmienda=${encodeURIComponent(row.value.amendment.id)}`
    : null,
);

/** Each amendment starts at its top. */
const body = ref<HTMLElement | null>(null);
watch(amendmentId, async () => {
  await nextTick();
  body.value?.parentElement?.scrollTo({ top: 0 });
});
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
    :ui="{
      content: 'max-w-3xl',
      body: 'p-4 sm:p-6',
      footer: 'flex flex-wrap items-center gap-2',
    }"
  >
    <template #body>
      <div v-if="row" ref="body">
        <LiveViewAmendmentSummary
          :amendment="row.amendment"
          :document="document"
          :state="row.state"
          :note="note"
          :show-position="showPosition"
          heading-level="h2"
        />
      </div>
    </template>

    <template #footer>
      <UButton
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="outline"
        size="lg"
        :disabled="!previous"
        :aria-label="t('liveView.amendmentWindow.previous')"
        @click="previous && (amendmentId = previous.amendment.id)"
      />
      <UButton
        icon="i-lucide-chevron-right"
        color="neutral"
        variant="outline"
        size="lg"
        :disabled="!next"
        :aria-label="t('liveView.amendmentWindow.next')"
        @click="next && (amendmentId = next.amendment.id)"
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
