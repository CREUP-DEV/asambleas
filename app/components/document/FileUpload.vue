<script setup lang="ts">
import type { DocumentDto } from "~~/shared/types/api";

/**
 * The PDF of a `file` document: shows the current file with a link to open
 * it and a drop zone to upload or replace it (POST .../file, multipart
 * `file` plus `updatedAt`). Emits `uploaded` with the updated document, and
 * `stale` after an optimistic-lock conflict. With `replaceable` false (the
 * PDF was voted) only the current file shows.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentDto;
    /** "/api/assemblies/{assembly}/documents/{document}" (slugs or ids). */
    documentApi: string;
    disabled?: boolean;
    /** Show the drop zone to upload or replace the PDF. */
    replaceable?: boolean;
  }>(),
  { disabled: false, replaceable: true },
);

const emit = defineEmits<{
  uploaded: [document: DocumentDto];
  stale: [];
}>();

const { t } = useI18n();
const toast = useToast();
const { send, notifyError, errorStatus, isConflict } = useApi();

const PDF_MAX_BYTES = 20 * 1024 * 1024;

const file = ref<File | null>(null);
const uploading = ref(false);
const statusMessage = ref("");

function reject(key: string): void {
  toast.add({
    title: t("document.file.error"),
    description: t(key),
    color: "error",
    icon: "i-lucide-circle-alert",
  });
}

watch(file, (selected) => {
  if (selected) void upload(selected);
});

async function upload(selected: File): Promise<void> {
  const isPdf =
    selected.type === "application/pdf" || /\.pdf$/i.test(selected.name);
  if (!isPdf) {
    reject("document.file.invalidType");
    file.value = null;
    return;
  }
  if (selected.size > PDF_MAX_BYTES) {
    reject("document.file.tooLarge");
    file.value = null;
    return;
  }

  uploading.value = true;
  statusMessage.value = t("document.file.uploading", { name: selected.name });
  try {
    const body = new FormData();
    body.append("file", selected, selected.name);
    body.append("updatedAt", props.document.updatedAt);
    const updated = await send<DocumentDto>(`${props.documentApi}/file`, {
      body,
    });
    emit("uploaded", updated);
    statusMessage.value = t("document.file.uploaded");
    toast.add({
      title: t("document.file.uploaded"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    statusMessage.value = "";
    const status = errorStatus(error);
    if (status === 415) reject("document.file.invalidType");
    else if (status === 413) reject("document.file.tooLarge");
    else notifyError(error, "document.file.error");
    if (isConflict(error)) emit("stale");
  } finally {
    uploading.value = false;
    file.value = null;
  }
}
</script>

<template>
  <section class="space-y-4" :aria-busy="uploading">
    <div
      v-if="document.fileUrl"
      class="border-default bg-elevated/40 flex flex-wrap items-center gap-3 rounded-md border p-3"
    >
      <UIcon
        name="i-lucide-file-text"
        class="text-primary size-8 shrink-0"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <p class="text-muted text-xs">{{ t("document.file.current") }}</p>
        <p class="text-highlighted truncate text-sm font-medium">
          {{ document.fileName ?? t("document.file.unnamed") }}
        </p>
      </div>
      <UButton
        :to="document.fileUrl"
        target="_blank"
        rel="noopener"
        external
        icon="i-lucide-external-link"
        color="neutral"
        variant="outline"
        size="sm"
        :label="t('document.file.view')"
        :aria-label="`${t('document.file.view')} ${t('document.file.opensNewTab')}`"
      />
    </div>
    <UAlert
      v-else
      color="warning"
      variant="subtle"
      icon="i-lucide-file-warning"
      :title="t('document.file.none')"
      :description="t('document.file.noneDescription')"
    />

    <UFileUpload
      v-if="replaceable"
      v-model="file"
      accept="application/pdf,.pdf"
      variant="area"
      layout="list"
      icon="i-lucide-upload"
      :label="
        document.fileUrl
          ? t('document.file.replaceLabel')
          : t('document.file.dropLabel')
      "
      :description="t('document.file.dropDescription')"
      :disabled="disabled || uploading"
      :preview="false"
      class="min-h-36 w-full"
    />

    <p class="text-muted flex min-h-5 items-center gap-2 text-sm" role="status">
      <UIcon
        v-if="uploading"
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
        aria-hidden="true"
      />
      {{ statusMessage }}
    </p>
  </section>
</template>
