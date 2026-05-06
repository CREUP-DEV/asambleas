<script setup lang="ts">
const { t } = useI18n();

interface AmendmentAuthor {
  id: string;
  name: string;
  email: string;
  externalInitials: string | null;
}

interface Amendment {
  id: string;
  documentId: string;
  submittedBy: string;
  status: string;
  type: string;
  justification: string;
  contentPatch: string;
  baseContentVersion: string;
  parentAmendmentId: string | null;
  createdAt: string;
  submittedAt: string | null;
  updatedAt: string;
  author?: AmendmentAuthor;
}

interface Document {
  id: string;
  content: string | null;
  proponentId: string | null;
  contentHistory: Array<{
    contentHash: string;
    amendmentId: string;
    type: "formal" | "accepted_proponent" | "approved_vote";
    incorporatedAt: string;
  }>;
}

const props = defineProps<{
  assemblyId: string;
  itemId: string;
  document: Document;
  canCreate: boolean;
  allowAmendments: boolean;
  deadlinePassed: boolean;
}>();

const emit = defineEmits<{
  updated: [];
}>();

const {
  data: amendments,
  refresh,
  status: fetchStatus,
} = useFetch<Amendment[]>(
  () =>
    `/api/assemblies/${props.assemblyId}/agenda-items/${props.itemId}/documents/${props.document.id}/amendments`,
  { default: () => [] },
);

const showCreateForm = ref(false);
const selectedId = ref<string | null>(null);

const selectedAmendment = computed(
  () => amendments.value.find((a) => a.id === selectedId.value) ?? null,
);

const documentRef = computed(() => props.document);

function onSaved() {
  showCreateForm.value = false;
  void refresh();
  emit("updated");
}

function onUpdated() {
  void refresh();
  emit("updated");
}

const canShowCreate = computed(
  () =>
    props.canCreate &&
    props.allowAmendments &&
    !props.deadlinePassed &&
    Boolean(props.document.content),
);
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-lg font-semibold">{{ t("amendment.title") }}</h3>
      <UButton
        v-if="canShowCreate && !showCreateForm"
        :label="t('amendment.create')"
        icon="i-tabler-plus"
        size="sm"
        @click="showCreateForm = true"
      />
    </div>

    <UAlert
      v-if="!allowAmendments"
      color="neutral"
      variant="subtle"
      icon="i-tabler-info-circle"
      :description="t('amendment.onlyPlatform')"
    />

    <UAlert
      v-else-if="deadlinePassed && canCreate"
      color="warning"
      variant="subtle"
      icon="i-tabler-clock"
      :description="t('amendment.deadlinePassed')"
    />

    <!-- Create form -->
    <div v-if="showCreateForm" class="border-default rounded-lg border p-4">
      <AmendmentForm
        :assembly-id="assemblyId"
        :item-id="itemId"
        :doc-id="document.id"
        :document-content="document.content ?? ''"
        @saved="onSaved"
        @cancel="showCreateForm = false"
      />
    </div>

    <DocumentTimeline
      :history="document.contentHistory"
      :amendments="amendments"
    />

    <div v-if="fetchStatus === 'pending'" class="py-8 text-center">
      <UIcon name="i-tabler-loader-2" class="text-muted size-6 animate-spin" />
    </div>

    <div
      v-else-if="amendments.length === 0"
      class="text-muted py-8 text-center"
    >
      <p class="font-medium">{{ t("amendment.noAmendments") }}</p>
      <p class="mt-1 text-sm">{{ t("amendment.noAmendmentsDescription") }}</p>
    </div>

    <div v-else class="space-y-3">
      <AmendmentCard
        v-for="amendment in amendments"
        :key="amendment.id"
        :amendment="amendment"
        :selected="amendment.id === selectedId"
        @select="selectedId = selectedId === $event ? null : $event"
      />
    </div>

    <!-- Selected amendment actions -->
    <div v-if="selectedAmendment" class="border-default rounded-lg border p-4">
      <div class="mb-3">
        <h4 class="text-sm font-medium">
          {{ t("amendment.justification") }}
        </h4>
        <p class="text-muted mt-1 text-sm">
          {{ selectedAmendment.justification }}
        </p>
      </div>

      <AmendmentDiff
        :base-content="document.content"
        :content-patch="selectedAmendment.contentPatch"
      />

      <AmendmentActions
        :amendment="selectedAmendment"
        :document="documentRef"
        :assembly-id="assemblyId"
        :item-id="itemId"
        :doc-id="document.id"
        @updated="onUpdated"
      />
    </div>
  </div>
</template>
