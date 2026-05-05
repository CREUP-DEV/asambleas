<script setup lang="ts">
import { DOCUMENT_STATUSES } from "~~/shared/constants/statuses";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

interface Document {
  id: string;
  title: string;
  type: "platform" | "pdf";
  status: string;
  fileUrl: string | null;
  submittedBy: string | null;
  submittedByUser?: { id: string; name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

const props = defineProps<{
  assemblyId: string;
  itemId: string;
  canManage: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const { t } = useI18n();
const toast = useToast();

const { data: documents, refresh } = await useFetch<Document[]>(
  `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents`,
);

const deleteId = ref<string | null>(null);
const deleteLoading = ref(false);
const deleteModalOpen = computed({
  get: () => deleteId.value !== null,
  set: (value: boolean) => {
    if (!value) deleteId.value = null;
  },
});

const deleteDoc = async () => {
  if (!deleteId.value) return;
  deleteLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(
      `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents/${deleteId.value}`,
      {
        method: "DELETE",
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("document.deleted"), color: "success" });
    deleteId.value = null;
    await refresh();
    emit("refresh");
  } catch {
    toast.add({ title: t("errors.serverError"), color: "error" });
  } finally {
    deleteLoading.value = false;
  }
};

const acceptDoc = async (doc: Document) => {
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(
      `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents/${doc.id}/status`,
      {
        method: "PUT",
        body: {
          status: DOCUMENT_STATUSES.ACCEPTED,
          updatedAt: new Date(doc.updatedAt).toISOString(),
        },
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("document.statusChanged"), color: "success" });
    await refresh();
    emit("refresh");
  } catch (err: unknown) {
    const code = (err as { statusCode?: number })?.statusCode;
    toast.add({
      title: code === 409 ? t("errors.conflict") : t("errors.serverError"),
      color: "error",
    });
  }
};

const statusColor = (status: string) => {
  if (status === DOCUMENT_STATUSES.ACCEPTED) return "success";
  if (status === DOCUMENT_STATUSES.PENDING_REVIEW) return "warning";
  return "neutral";
};
</script>

<template>
  <div>
    <div v-if="!documents || documents.length === 0" class="py-8 text-center">
      <p class="text-muted text-sm">{{ t("document.noDocuments") }}</p>
      <p class="text-muted mt-1 text-xs">
        {{ t("document.noDocumentsDescription") }}
      </p>
    </div>

    <ul v-else class="divide-y divide-default">
      <li
        v-for="doc in documents"
        :key="doc.id"
        class="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
      >
        <UIcon
          :name="
            doc.type === 'pdf' ? 'i-tabler-file-type-pdf' : 'i-tabler-file-text'
          "
          class="text-muted shrink-0"
          size="20"
        />

        <div class="min-w-0 flex-1">
          <NuxtLink
            :to="`/asambleas/${assemblyId}/punto/${itemId}/documento/${doc.id}`"
            class="text-sm font-medium hover:underline"
          >
            {{ doc.title }}
          </NuxtLink>
          <div class="text-muted mt-0.5 flex items-center gap-2 text-xs">
            <span>{{ t(`document.types.${doc.type}`) }}</span>
            <span v-if="doc.submittedByUser">
              · {{ t("document.submittedBy") }} {{ doc.submittedByUser.name }}
            </span>
          </div>
        </div>

        <UBadge
          :label="t(`document.statuses.${doc.status}`)"
          :color="statusColor(doc.status)"
          variant="subtle"
          size="sm"
        />

        <div v-if="canManage" class="flex shrink-0 items-center gap-1">
          <UButton
            v-if="doc.status === DOCUMENT_STATUSES.PENDING_REVIEW"
            size="xs"
            color="success"
            variant="ghost"
            icon="i-tabler-check"
            :aria-label="t('document.accept')"
            @click="acceptDoc(doc)"
          />
          <UButton
            size="xs"
            color="error"
            variant="ghost"
            icon="i-tabler-trash"
            :aria-label="t('document.delete')"
            @click="deleteId = doc.id"
          />
        </div>
      </li>
    </ul>

    <UModal v-model:open="deleteModalOpen" :title="t('document.deleteConfirm')">
      <template #body>
        <p class="text-muted text-sm">
          {{ t("document.deleteConfirmDescription") }}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="deleteId = null">
            {{ t("common.cancel") }}
          </UButton>
          <UButton color="error" :loading="deleteLoading" @click="deleteDoc">
            {{ t("common.delete") }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
