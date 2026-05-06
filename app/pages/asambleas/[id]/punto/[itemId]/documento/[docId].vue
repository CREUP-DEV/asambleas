<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { DOCUMENT_STATUSES } from "~~/shared/constants/statuses";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const { t, locale } = useI18n();
const route = useRoute();
const localePath = useLocalePath();
const toast = useToast();
const { hasPermission } = usePermissions();

const assemblyId = route.params.id as string;
const itemId = route.params.itemId as string;
const docId = route.params.docId as string;

interface DocumentDetail {
  id: string;
  title: string;
  type: "platform" | "pdf";
  status: string;
  content: string | null;
  contentHistory: Array<{
    contentHash: string;
    amendmentId: string;
    type: "formal" | "accepted_proponent" | "approved_vote";
    incorporatedAt: string;
  }>;
  fileUrl: string | null;
  submittedBy: string | null;
  proponentId: string | null;
  submittedByUser?: {
    id: string;
    name: string;
    email: string;
    externalInitials: string | null;
  } | null;
  proponent?: {
    id: string;
    name: string;
    email: string;
    externalInitials: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

const { data: doc, refresh } = await useFetch<DocumentDetail>(
  `/api/assemblies/${assemblyId}/agenda-items/${itemId}/documents/${docId}`,
);

if (!doc.value) {
  throw createError({ statusCode: 404, statusMessage: "Not Found" });
}

interface AgendaItemInfo {
  id: string;
  allowAmendments: boolean;
  amendmentDeadline: string | null;
}

const { data: agendaItem } = await useFetch<AgendaItemInfo>(
  `/api/assemblies/${assemblyId}/agenda-items/${itemId}`,
  {
    default: () => ({
      id: "",
      allowAmendments: false,
      amendmentDeadline: null,
    }),
  },
);

useHead({ title: computed(() => doc.value?.title ?? "") });

const canManage = computed(() =>
  hasPermission(PERMISSION_KEYS.DOCUMENT_MANAGE),
);
const canReview = computed(() =>
  hasPermission(PERMISSION_KEYS.AMENDMENT_REVIEW),
);
const canCreateAmendment = computed(() =>
  hasPermission(PERMISSION_KEYS.AMENDMENT_CREATE),
);

const allowAmendments = computed(
  () => agendaItem.value?.allowAmendments ?? false,
);
const amendmentDeadlinePassed = computed(() => {
  if (!agendaItem.value?.amendmentDeadline) return false;
  return new Date() > new Date(agendaItem.value.amendmentDeadline);
});

const isPending = computed(
  () => doc.value?.status === DOCUMENT_STATUSES.PENDING_REVIEW,
);
const isAccepted = computed(
  () => doc.value?.status === DOCUMENT_STATUSES.ACCEPTED,
);

const editModalOpen = ref(false);
const deleteModalOpen = ref(false);
const deleteLoading = ref(false);
const acceptLoading = ref(false);

const dateFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
);

const acceptDoc = async () => {
  if (!doc.value) return;
  acceptLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(
      `/api/assemblies/${assemblyId}/agenda-items/${itemId}/documents/${docId}/status`,
      {
        method: "PUT",
        body: {
          status: DOCUMENT_STATUSES.ACCEPTED,
          updatedAt: new Date(doc.value.updatedAt).toISOString(),
        },
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("document.statusChanged"), color: "success" });
    await refresh();
  } catch (err: unknown) {
    const code = (err as { statusCode?: number })?.statusCode;
    toast.add({
      title: code === 409 ? t("errors.conflict") : t("errors.serverError"),
      color: "error",
    });
  } finally {
    acceptLoading.value = false;
  }
};

const router = useRouter();

const deleteDoc = async () => {
  deleteLoading.value = true;
  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    await $fetch(
      `/api/assemblies/${assemblyId}/agenda-items/${itemId}/documents/${docId}`,
      {
        method: "DELETE",
        headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
      },
    );
    toast.add({ title: t("document.deleted"), color: "success" });
    await router.push(localePath(`/asambleas/${assemblyId}/punto/${itemId}`));
  } catch {
    toast.add({ title: t("errors.serverError"), color: "error" });
    deleteLoading.value = false;
  }
};

const statusColor = (status: string) => {
  if (status === DOCUMENT_STATUSES.ACCEPTED) return "success";
  if (status === DOCUMENT_STATUSES.PENDING_REVIEW) return "warning";
  return "neutral";
};
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <NuxtLink
          :to="localePath(`/asambleas/${assemblyId}/punto/${itemId}`)"
          class="text-muted mb-1 flex items-center gap-1 text-xs hover:underline"
        >
          <UIcon name="i-tabler-chevron-left" size="14" />
          {{ t("document.backToItem") }}
        </NuxtLink>
        <h1 class="text-xl font-semibold">{{ doc?.title }}</h1>
        <div class="text-muted mt-1 flex items-center gap-3 text-sm">
          <UBadge
            v-if="doc"
            :label="t(`document.statuses.${doc.status}`)"
            :color="statusColor(doc.status)"
            variant="subtle"
            size="sm"
          />
          <span>{{ t(`document.types.${doc?.type}`) }}</span>
          <span v-if="doc?.submittedByUser">
            {{ t("document.submittedBy") }} {{ doc.submittedByUser.name }}
          </span>
          <span v-if="doc">
            {{ dateFormatter.format(new Date(doc.createdAt)) }}
          </span>
        </div>
      </div>

      <div v-if="canManage" class="flex shrink-0 items-center gap-2">
        <UButton
          v-if="isPending && canReview"
          icon="i-tabler-check"
          color="success"
          :loading="acceptLoading"
          @click="acceptDoc"
        >
          {{ t("document.accept") }}
        </UButton>
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-tabler-pencil"
          :aria-label="t('document.edit')"
          @click="editModalOpen = true"
        />
        <UButton
          variant="ghost"
          color="error"
          icon="i-tabler-trash"
          :aria-label="t('document.delete')"
          @click="deleteModalOpen = true"
        />
      </div>
    </div>

    <!-- Pending review notice -->
    <UAlert
      v-if="isPending"
      icon="i-tabler-clock"
      color="warning"
      variant="subtle"
      :description="t('document.pending')"
      class="mb-6"
    />

    <!-- Document content -->
    <div v-if="doc" class="rounded-xl border border-default bg-background p-6">
      <DocumentViewer
        :type="doc.type"
        :content="doc.content"
        :file-url="doc.fileUrl"
        :title="doc.title"
      />
    </div>

    <!-- Amendments section -->
    <div v-if="doc?.type === 'platform' && isAccepted" class="mt-8">
      <AmendmentList
        :assembly-id="assemblyId"
        :item-id="itemId"
        :document="{
          id: doc.id,
          content: doc.content,
          proponentId: doc.proponentId,
          contentHistory: doc.contentHistory ?? [],
        }"
        :can-create="canCreateAmendment"
        :allow-amendments="allowAmendments"
        :deadline-passed="amendmentDeadlinePassed"
        @updated="refresh"
      />
    </div>

    <!-- Edit modal -->
    <UModal
      v-model:open="editModalOpen"
      :title="t('document.edit')"
      class="max-w-2xl"
    >
      <template #body>
        <DocumentForm
          v-if="doc"
          :assembly-id="assemblyId"
          :item-id="itemId"
          :allow-pdf="canManage"
          :existing="{
            id: doc.id,
            type: doc.type,
            title: doc.title,
            content: doc.content,
            fileUrl: doc.fileUrl,
            updatedAt: doc.updatedAt,
          }"
          @saved="
            editModalOpen = false;
            refresh();
          "
          @cancel="editModalOpen = false"
        />
      </template>
    </UModal>

    <!-- Delete modal -->
    <UModal v-model:open="deleteModalOpen" :title="t('document.deleteConfirm')">
      <template #body>
        <p class="text-muted text-sm">
          {{ t("document.deleteConfirmDescription") }}
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton
            variant="ghost"
            color="neutral"
            @click="deleteModalOpen = false"
          >
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
