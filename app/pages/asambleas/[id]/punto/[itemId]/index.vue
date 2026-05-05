<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { DOCUMENT_STATUSES } from "~~/shared/constants/statuses";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const localePath = useLocalePath();
const { hasPermission } = usePermissions();

const assemblyId = route.params.id as string;
const itemId = route.params.itemId as string;

interface AgendaItem {
  id: string;
  assemblyId: string;
  title: string;
  order: number;
  parentId: string | null;
  allowDocumentSubmission: boolean;
  documentSubmissionDeadline: string | null;
  allowAmendments: boolean;
  amendmentDeadline: string | null;
}

interface Document {
  id: string;
  title: string;
  type: "platform" | "pdf";
  status: string;
  fileUrl: string | null;
  content: string | null;
  submittedBy: string | null;
  updatedAt: string;
  createdAt: string;
}

const [{ data: item }, { data: documents, refresh: refreshDocs }] =
  await Promise.all([
    useFetch<AgendaItem>(
      `/api/assemblies/${assemblyId}/agenda-items/${itemId}`,
    ),
    useFetch<Document[]>(
      `/api/assemblies/${assemblyId}/agenda-items/${itemId}/documents`,
    ),
  ]);

if (!item.value) {
  throw createError({ statusCode: 404, statusMessage: "Not Found" });
}

useHead({ title: computed(() => item.value?.title ?? "") });

const canManage = computed(() =>
  hasPermission(PERMISSION_KEYS.DOCUMENT_MANAGE),
);
const canCreate = computed(() =>
  hasPermission(PERMISSION_KEYS.DOCUMENT_CREATE),
);

const canSubmit = computed(() => {
  if (!item.value?.allowDocumentSubmission) return false;
  if (!item.value.documentSubmissionDeadline) return true;
  return new Date() <= new Date(item.value.documentSubmissionDeadline);
});

const showCreate = computed(
  () => canManage.value || (canCreate.value && canSubmit.value),
);
const resolvedAssemblyId = computed(() => item.value?.assemblyId ?? assemblyId);
const resolvedItemId = computed(() => item.value?.id ?? itemId);

const createModalOpen = ref(false);

const onDocSaved = async () => {
  createModalOpen.value = false;
  await refreshDocs();

  // Single document shortcut: navigate directly if exactly 1 accepted doc
  const accepted = documents.value?.filter(
    (d) => d.status === DOCUMENT_STATUSES.ACCEPTED,
  );
  if (accepted?.length === 1) {
    await router.push(
      localePath(
        `/asambleas/${assemblyId}/punto/${itemId}/documento/${accepted[0]!.id}`,
      ),
    );
  }
};

// On initial load: if exactly 1 accepted doc, go there directly
onMounted(async () => {
  if (canManage.value) return;
  const accepted = documents.value?.filter(
    (d) => d.status === DOCUMENT_STATUSES.ACCEPTED,
  );
  if (accepted?.length === 1) {
    await router.replace(
      localePath(
        `/asambleas/${assemblyId}/punto/${itemId}/documento/${accepted[0]!.id}`,
      ),
    );
  }
});
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between gap-4">
      <div>
        <NuxtLink
          :to="localePath(`/asambleas/${assemblyId}`)"
          class="text-muted mb-1 flex items-center gap-1 text-xs hover:underline"
        >
          <UIcon name="i-tabler-chevron-left" size="14" />
          {{ t("common.back") }}
        </NuxtLink>
        <h1 class="text-xl font-semibold">{{ item?.title }}</h1>
      </div>

      <UButton
        v-if="showCreate"
        icon="i-tabler-plus"
        @click="createModalOpen = true"
      >
        {{ t("document.create") }}
      </UButton>
    </div>

    <DocumentList
      :assembly-id="resolvedAssemblyId"
      :item-id="resolvedItemId"
      :assembly-slug="assemblyId"
      :item-slug="itemId"
      :can-manage="canManage"
      @refresh="refreshDocs"
    />

    <UModal
      v-model:open="createModalOpen"
      :title="t('document.create')"
      class="max-w-2xl"
    >
      <template #body>
        <DocumentForm
          :assembly-id="resolvedAssemblyId"
          :item-id="resolvedItemId"
          :allow-pdf="canManage"
          @saved="onDocSaved"
          @cancel="createModalOpen = false"
        />
      </template>
    </UModal>
  </div>
</template>
