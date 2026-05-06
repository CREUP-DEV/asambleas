<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const { t } = useI18n();

interface Amendment {
  id: string;
  documentId: string;
  submittedBy: string;
  status: string;
  type: string;
  justification: string;
  parentAmendmentId: string | null;
  updatedAt: string | Date;
}

interface Document {
  proponentId: string | null;
  content: string | null;
}

const props = defineProps<{
  amendment: Amendment;
  document: Document;
  assemblyId: string;
  itemId: string;
  docId: string;
}>();

const emit = defineEmits<{
  updated: [];
}>();

const toast = useToast();
const loading = ref(false);
const transactionalOpen = ref(false);
const transactionalContent = ref(props.document.content ?? "");
const transactionalJustification = ref("");

const amendmentRef = computed(() => props.amendment);
const documentRef = computed(() => props.document);

const {
  canSubmit,
  canReview,
  canDecideAsProponent,
  canRecordVote,
  canCreateTransactional,
} = useAmendmentWorkflow(amendmentRef, documentRef);

const basePath = computed(
  () =>
    `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents/${props.docId}/amendments/${props.amendment.id}`,
);

const updatedAtIso = computed(() =>
  props.amendment.updatedAt instanceof Date
    ? props.amendment.updatedAt.toISOString()
    : props.amendment.updatedAt,
);

const mutationHeaders = () => {
  const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
  return csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined;
};

const getErrorMessage = (error: unknown) => {
  return (
    (error as { data?: { message?: string } })?.data?.message ??
    t("errors.serverError")
  );
};

async function submit() {
  loading.value = true;
  try {
    await $fetch(`${basePath.value}/submit`, {
      method: "PUT",
      headers: mutationHeaders(),
    });
    toast.add({ title: t("amendment.submitted"), color: "success" });
    emit("updated");
  } catch (error: unknown) {
    toast.add({
      title: getErrorMessage(error),
      color: "error",
    });
  } finally {
    loading.value = false;
  }
}

async function review(action: "reject" | "accept" | "formal") {
  loading.value = true;
  try {
    await $fetch(`${basePath.value}/review`, {
      method: "PUT",
      body: { action, updatedAt: updatedAtIso.value },
      headers: mutationHeaders(),
    });
    toast.add({ title: t("amendment.reviewed"), color: "success" });
    emit("updated");
  } catch (error: unknown) {
    toast.add({
      title: getErrorMessage(error),
      color: "error",
    });
  } finally {
    loading.value = false;
  }
}

async function proponentDecision(action: "accept" | "reject") {
  loading.value = true;
  try {
    await $fetch(`${basePath.value}/proponent-decision`, {
      method: "PUT",
      body: { action, updatedAt: updatedAtIso.value },
      headers: mutationHeaders(),
    });
    toast.add({ title: t("amendment.proponentDecided"), color: "success" });
    emit("updated");
  } catch (error: unknown) {
    toast.add({
      title: getErrorMessage(error),
      color: "error",
    });
  } finally {
    loading.value = false;
  }
}

async function voteResult(result: "approved" | "rejected") {
  loading.value = true;
  try {
    await $fetch(`${basePath.value}/vote-result`, {
      method: "PUT",
      body: { result, updatedAt: updatedAtIso.value },
      headers: mutationHeaders(),
    });
    toast.add({ title: t("amendment.voteRecorded"), color: "success" });
    emit("updated");
  } catch (error: unknown) {
    toast.add({
      title: getErrorMessage(error),
      color: "error",
    });
  } finally {
    loading.value = false;
  }
}

async function createTransactional() {
  if (
    !transactionalContent.value.trim() ||
    !transactionalJustification.value.trim()
  ) {
    return;
  }

  loading.value = true;
  try {
    await $fetch(`${basePath.value}/transactional`, {
      method: "POST",
      body: {
        content: transactionalContent.value,
        justification: transactionalJustification.value,
      },
      headers: mutationHeaders(),
    });
    toast.add({ title: t("amendment.transactionalCreated"), color: "success" });
    transactionalOpen.value = false;
    transactionalContent.value = props.document.content ?? "";
    transactionalJustification.value = "";
    emit("updated");
  } catch (error: unknown) {
    toast.add({
      title: getErrorMessage(error),
      color: "error",
    });
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <!-- Submit (author, draft) -->
    <UButton
      v-if="canSubmit"
      color="primary"
      variant="soft"
      size="sm"
      :label="t('amendment.submit')"
      :loading="loading"
      icon="i-tabler-send"
      @click="submit"
    />

    <!-- Review (Secretaría, pending_review) -->
    <template v-if="canReview">
      <UButton
        color="success"
        variant="soft"
        size="sm"
        :label="t('amendment.reviewAction.accept')"
        :loading="loading"
        icon="i-tabler-check"
        @click="review('accept')"
      />
      <UButton
        color="info"
        variant="soft"
        size="sm"
        :label="t('amendment.reviewAction.formal')"
        :loading="loading"
        icon="i-tabler-file-check"
        @click="review('formal')"
      />
      <UButton
        color="error"
        variant="soft"
        size="sm"
        :label="t('amendment.reviewAction.reject')"
        :loading="loading"
        icon="i-tabler-x"
        @click="review('reject')"
      />
    </template>

    <!-- Proponent decision (accepted_secretaria) -->
    <template v-if="canDecideAsProponent">
      <UButton
        color="success"
        variant="soft"
        size="sm"
        :label="t('amendment.proponentAction.accept')"
        :loading="loading"
        icon="i-tabler-check"
        @click="proponentDecision('accept')"
      />
      <UButton
        color="error"
        variant="soft"
        size="sm"
        :label="t('amendment.proponentAction.reject')"
        :loading="loading"
        icon="i-tabler-x"
        @click="proponentDecision('reject')"
      />
    </template>

    <!-- Vote result (rejected_proponent) -->
    <template v-if="canRecordVote">
      <UButton
        color="success"
        variant="soft"
        size="sm"
        :label="t('amendment.voteAction.approved')"
        :loading="loading"
        icon="i-tabler-thumb-up"
        @click="voteResult('approved')"
      />
      <UButton
        color="error"
        variant="soft"
        size="sm"
        :label="t('amendment.voteAction.rejected')"
        :loading="loading"
        icon="i-tabler-thumb-down"
        @click="voteResult('rejected')"
      />
    </template>

    <UButton
      v-if="canCreateTransactional"
      color="neutral"
      variant="soft"
      size="sm"
      :label="t('amendment.transactional')"
      :loading="loading"
      icon="i-tabler-arrows-exchange"
      @click="transactionalOpen = true"
    />

    <UModal
      v-model:open="transactionalOpen"
      :title="t('amendment.transactional')"
      class="max-w-2xl"
    >
      <template #body>
        <form class="space-y-4" @submit.prevent="createTransactional">
          <UAlert
            color="neutral"
            variant="subtle"
            icon="i-tabler-info-circle"
            :description="t('amendment.transactionalDescription')"
          />
          <UFormField :label="t('amendment.content')">
            <DocumentRichTextEditor v-model="transactionalContent" />
          </UFormField>
          <UFormField :label="t('amendment.justification')">
            <UTextarea
              v-model="transactionalJustification"
              :placeholder="t('amendment.justificationPlaceholder')"
              :rows="4"
              autoresize
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :label="t('common.cancel')"
              @click="transactionalOpen = false"
            />
            <UButton
              type="submit"
              :label="t('amendment.transactional')"
              :loading="loading"
            />
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
