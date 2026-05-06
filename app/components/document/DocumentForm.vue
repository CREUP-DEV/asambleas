<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

interface ExistingDocument {
  id: string;
  type: "platform" | "pdf";
  title: string;
  content: string | null;
  fileUrl: string | null;
  updatedAt: string;
}

const props = defineProps<{
  assemblyId: string;
  itemId: string;
  existing?: ExistingDocument;
  allowPdf?: boolean;
}>();

const emit = defineEmits<{
  saved: [];
  cancel: [];
}>();

const { t } = useI18n();
const toast = useToast();

const isEdit = computed(() => !!props.existing);

const docType = ref<"platform" | "pdf">(props.existing?.type ?? "platform");
const title = ref(props.existing?.title ?? "");
const content = ref(props.existing?.content ?? "");
const fileUrl = ref(props.existing?.fileUrl ?? "");
const uploading = ref(false);
const saving = ref(false);
const titleTouched = ref(false);

const titleError = computed(() =>
  titleTouched.value && !title.value.trim()
    ? t("validation.titleRequired")
    : undefined,
);

const typeOptions = computed(() => [
  { label: t("document.types.platform"), value: "platform" },
  ...(props.allowPdf ? [{ label: t("document.types.pdf"), value: "pdf" }] : []),
]);

const fileInput = ref<HTMLInputElement | null>(null);

const handleFileChange = async (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  uploading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    const form = new FormData();
    form.append("file", file);
    const result = await $fetch<{ fileUrl: string }>(
      "/api/uploads/document-pdf",
      {
        method: "POST",
        body: form,
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    fileUrl.value = result.fileUrl;
  } catch {
    toast.add({ title: t("errors.serverError"), color: "error" });
  } finally {
    uploading.value = false;
  }
};

const save = async () => {
  if (!title.value.trim()) return;

  if (docType.value === "platform" && !content.value.trim()) return;
  if (docType.value === "pdf" && !fileUrl.value) return;

  saving.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;

    if (isEdit.value && props.existing) {
      const body =
        docType.value === "platform"
          ? {
              title: title.value,
              content: content.value,
              updatedAt: new Date(props.existing.updatedAt).toISOString(),
            }
          : {
              title: title.value,
              fileUrl: fileUrl.value,
              updatedAt: new Date(props.existing.updatedAt).toISOString(),
            };

      await $fetch(
        `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents/${props.existing.id}`,
        {
          method: "PUT",
          body,
          headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
        },
      );
      toast.add({ title: t("document.updated"), color: "success" });
    } else {
      const body =
        docType.value === "platform"
          ? { title: title.value, content: content.value }
          : { title: title.value, fileUrl: fileUrl.value };

      await $fetch(
        `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents?type=${docType.value}`,
        {
          method: "POST",
          body,
          headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
        },
      );
      toast.add({ title: t("document.created"), color: "success" });
    }

    emit("saved");
  } catch (err: unknown) {
    const code = (err as { statusCode?: number })?.statusCode;
    toast.add({
      title: code === 409 ? t("errors.conflict") : t("errors.serverError"),
      color: "error",
    });
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <div class="space-y-4">
    <UFormField v-if="!isEdit" :label="t('document.typeSelect')">
      <USelectMenu
        v-model="docType"
        :items="typeOptions"
        value-key="value"
        :disabled="isEdit"
      />
    </UFormField>

    <UFormField :label="t('document.titleLabel')" required :error="titleError">
      <UInput
        v-model="title"
        :placeholder="t('document.titlePlaceholder')"
        class="w-full"
        @blur="titleTouched = true"
      />
    </UFormField>

    <UFormField
      v-if="docType === 'platform'"
      :label="t('document.contentLabel')"
      required
    >
      <ClientOnly>
        <DocumentRichTextEditor v-model="content" />
        <template #fallback>
          <div class="bg-elevated animate-pulse rounded-lg h-48" />
        </template>
      </ClientOnly>
    </UFormField>

    <UFormField v-else :label="t('document.uploadFile')" required>
      <div class="flex items-center gap-3">
        <input
          ref="fileInput"
          type="file"
          accept="application/pdf"
          class="hidden"
          @change="handleFileChange"
        />
        <UButton
          variant="outline"
          color="neutral"
          icon="i-tabler-upload"
          :loading="uploading"
          @click="fileInput?.click()"
        >
          {{ t("document.uploadFile") }}
        </UButton>
        <span v-if="fileUrl" class="text-muted text-sm truncate max-w-xs">
          {{ fileUrl.split("/").at(-1) }}
        </span>
      </div>
    </UFormField>

    <div class="flex justify-end gap-2">
      <UButton variant="ghost" color="neutral" @click="$emit('cancel')">
        {{ t("common.cancel") }}
      </UButton>
      <UButton
        :loading="saving"
        :disabled="
          !title.trim() ||
          (docType === 'platform' && !content.trim()) ||
          (docType === 'pdf' && !fileUrl)
        "
        @click="save"
      >
        {{ t("common.save") }}
      </UButton>
    </div>
  </div>
</template>
