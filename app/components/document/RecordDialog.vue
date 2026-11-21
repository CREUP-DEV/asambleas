<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";

/**
 * A document's record (DocumentMetadataForm: title, kind, presenters,
 * rules, deadlines…) edited in a side panel from a list, without opening
 * the document (user's decision of 2026-11-21: the documents page). It
 * reads the whole document when it opens, saves as the document's own
 * page does, and closes once saved, emitting `saved` so the list reads
 * itself again. With unsaved changes it does not close by a click outside
 * or Escape, only by its button.
 */
const props = defineProps<{
  /** The document to edit, by id; null while closed. */
  documentId: string | null;
  /** Its title, for the panel's heading while it loads. */
  title?: string | null;
}>();

const emit = defineEmits<{ saved: [document: DocumentDto] }>();

const open = defineModel<boolean>("open", { required: true });

const { t } = useI18n();
const api = useApi();
const { assembly, apiBase } = useCurrentAssembly();

const document = ref<DocumentDto | null>(null);
const loading = ref(false);
const failed = ref(false);
const dirty = ref(false);
/** Counts the reads: a late answer for another document is dropped. */
let reads = 0;

async function load(): Promise<void> {
  const id = props.documentId;
  if (!id) return;
  const read = ++reads;
  loading.value = true;
  failed.value = false;
  try {
    const dto = await api.get<DocumentDto>(
      `${apiBase.value}/documents/${encodeURIComponent(id)}`,
    );
    if (read === reads) document.value = dto;
  } catch {
    if (read === reads) failed.value = true;
  } finally {
    if (read === reads) loading.value = false;
  }
}

watch(
  [open, () => props.documentId],
  ([isOpen, id], previous) => {
    if (!isOpen || !id) return;
    const [wasOpen, previousId] = previous ?? [false, null];
    if (wasOpen && previousId === id && document.value) return;
    document.value = null;
    dirty.value = false;
    void load();
  },
  { immediate: true },
);

function onSaved(updated: DocumentDto): void {
  document.value = updated;
  dirty.value = false;
  emit("saved", updated);
  open.value = false;
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="document?.title ?? title ?? t('document.metadata.heading')"
    :description="t('document.metadata.heading')"
    :dismissible="!dirty"
  >
    <template #body>
      <div v-if="loading && !document" class="space-y-3" role="status">
        <span class="sr-only">{{ t("common.loading") }}</span>
        <USkeleton aria-hidden="true" class="h-10 w-full" />
        <USkeleton aria-hidden="true" class="h-24 w-full" />
        <USkeleton aria-hidden="true" class="h-10 w-2/3" />
      </div>
      <UAlert
        v-else-if="failed"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('documents.recordLoadError')"
        :actions="[
          {
            label: t('agenda.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => void load(),
          },
        ]"
      />
      <DocumentMetadataForm
        v-else-if="document && assembly"
        v-model:dirty="dirty"
        :document="document"
        :assembly="assembly"
        @saved="onSaved"
        @stale="load"
      />
    </template>
  </USlideover>
</template>
