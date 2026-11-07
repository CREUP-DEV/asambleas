<script setup lang="ts">
import { DOCUMENT_KIND_DEFAULTS } from "~~/shared/constants/domain";
import type { DocumentDto, DocumentUpdateBody } from "~~/shared/types/api";

/**
 * Switches an unpublished document between text on the platform and an
 * uploaded PDF (PUT .../documents/[document] with `format`). It sits above
 * the text or the PDF, says which one the document uses and offers the
 * other after a confirmation that says what changes: a PDF takes no
 * amendments, and the draft text or the PDF already uploaded stays for a
 * switch back.
 *
 * Presenters are offered a PDF only for types that take no amendments (as
 * when they create it); going back to text is always possible. With
 * `pending` (unsaved changes on the page) the switch waits for them to be
 * saved, so it never overwrites them or trips the optimistic lock.
 *
 * Emits `updated` with the stored document and `stale` after a conflict.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentDto;
    /** "/api/assemblies/{assembly}/documents/{document}" (slugs or ids). */
    documentApi: string;
    disabled?: boolean;
    /** The page holds unsaved changes. */
    pending?: boolean;
  }>(),
  { disabled: false, pending: false },
);

const emit = defineEmits<{
  updated: [document: DocumentDto];
  stale: [];
}>();

const { t } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();

const isFile = computed(() => props.document.format === "file");
const target = computed(() => (isFile.value ? "structured" : "file"));

/** Presenters may turn into a PDF only what takes no amendments. */
const offered = computed(
  () =>
    isFile.value ||
    props.document.can.manage ||
    !DOCUMENT_KIND_DEFAULTS[props.document.kind].amendable,
);

/** Something of the current format would be set aside by the switch. */
const keepsCurrent = computed(() =>
  isFile.value
    ? props.document.fileUrl !== null
    : (props.document.workingVersion?.blocks.length ?? 0) > 0,
);

const open = ref(false);
const saving = ref(false);
const statusMessage = ref("");

async function confirm(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const body: DocumentUpdateBody = {
      format: target.value,
      updatedAt: props.document.updatedAt,
    };
    const updated = await send<DocumentDto>(props.documentApi, {
      method: "PUT",
      body,
    });
    open.value = false;
    emit("updated", updated);
    const done = t(`document.formatSwitch.done.${target.value}`);
    statusMessage.value = done;
    toast.add({ title: done, color: "success", icon: "i-lucide-check" });
  } catch (error) {
    notifyError(error, "document.formatSwitch.error");
    if (isConflict(error)) {
      open.value = false;
      emit("stale");
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    v-if="offered"
    class="border-default flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-dashed px-3 py-2 text-sm"
    data-testid="document-format-switch"
  >
    <p class="text-muted flex min-w-0 items-start gap-2">
      <UIcon
        :name="isFile ? 'i-lucide-file-type' : 'i-lucide-file-text'"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>
        {{ t(`document.formatSwitch.current.${document.format}`) }}
        <span v-if="pending" class="block text-xs">
          {{ t("document.formatSwitch.saveFirst") }}
        </span>
      </span>
    </p>
    <UButton
      color="neutral"
      variant="outline"
      size="sm"
      :icon="isFile ? 'i-lucide-file-text' : 'i-lucide-file-up'"
      :label="t(`document.formatSwitch.to.${target}`)"
      :disabled="disabled || pending || saving"
      @click="open = true"
    />
    <p class="sr-only" role="status" aria-live="polite">
      {{ statusMessage }}
    </p>

    <UModal
      v-model:open="open"
      :title="t(`document.formatSwitch.confirm.${target}.title`)"
      :dismissible="!saving"
    >
      <template #body>
        <ul class="text-default list-disc space-y-1 ps-5 text-sm">
          <li>{{ t(`document.formatSwitch.confirm.${target}.effect`) }}</li>
          <li v-if="keepsCurrent">
            {{ t(`document.formatSwitch.confirm.${target}.kept`) }}
          </li>
        </ul>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="saving"
            @click="open = false"
          />
          <UButton
            :icon="isFile ? 'i-lucide-file-text' : 'i-lucide-file-up'"
            :label="t(`document.formatSwitch.to.${target}`)"
            :loading="saving"
            @click="confirm"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
