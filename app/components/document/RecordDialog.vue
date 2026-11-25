<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";
import { useDirtyDialog } from "~/composables/session/useDirtyDialog";
import { useLeaveGuard } from "~/composables/shell/useLeaveGuard";

/**
 * A document's record (DocumentMetadataForm: title, kind, presenters,
 * rules, deadlines…) edited in a side panel from a list, without opening
 * the document (user's decision of 2026-11-21: the documents page). It
 * reads the whole document when it opens, saves as the document's own
 * page does, and closes once saved, emitting `saved` so the list reads
 * itself again. "Guardar datos" sits in the panel's footer, always in
 * view. With unsaved changes, the X, Escape and a click outside
 * ask before discarding them (useDirtyDialog; E-143/M-134), and leaving
 * the page or reloading asks too (useLeaveGuard).
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

const hasWork = (): boolean => open.value && dirty.value;

// The slideover is bound as `:open` + `@update:open`, never `v-model:open`:
// its X closes through `update:open` and asks; Escape and a click outside,
// not dismissible while dirty, ask through `close:prevent`. A close after
// saving sets `open` itself and never asks.
const { dismissible, onOpenUpdate } = useDirtyDialog({
  open,
  dirty: hasWork,
  question: () => ({
    title: t("documents.recordDiscardTitle"),
    description: t("documents.recordDiscardDescription"),
  }),
});

useLeaveGuard(hasWork, () => t("documents.recordLeaveConfirm"));

/**
 * "Guardar datos" stays in the panel's footer, in view however long the
 * form is: a submit tied to the form by its id (E-143/M-134).
 */
const formId = useId();
const form = useTemplateRef<{ reset: () => void; saving: boolean }>("form");
const showForm = computed(
  () => !failed.value && Boolean(document.value && assembly.value),
);
const saving = computed(() => form.value?.saving ?? false);

function onSaved(updated: DocumentDto): void {
  document.value = updated;
  dirty.value = false;
  emit("saved", updated);
  open.value = false;
}
</script>

<template>
  <USlideover
    :open="open"
    :title="document?.title ?? title ?? t('document.metadata.heading')"
    :description="t('document.metadata.heading')"
    :dismissible="dismissible"
    @update:open="onOpenUpdate"
    @close:prevent="void onOpenUpdate(false)"
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
        ref="form"
        v-model:dirty="dirty"
        :form-id="formId"
        :actions="false"
        :document="document"
        :assembly="assembly"
        @saved="onSaved"
        @stale="load"
      />
    </template>
    <template v-if="showForm" #footer>
      <div class="flex w-full flex-wrap items-center justify-end gap-2">
        <UButton
          v-if="dirty"
          color="neutral"
          variant="ghost"
          :label="t('document.metadata.reset')"
          :disabled="saving"
          @click="form?.reset()"
        />
        <UButton
          type="submit"
          :form="formId"
          icon="i-lucide-save"
          :label="t('document.metadata.save')"
          :loading="saving"
          :disabled="!dirty"
        />
      </div>
    </template>
  </USlideover>
</template>
