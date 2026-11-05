<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import type {
  AmendmentDto,
  CorrectionBody,
  DocumentDto,
  DocumentSummaryDto,
  ReviewQueueDto,
} from "~~/shared/types/api";
import {
  applyAmendmentResults,
  groupReviewAmendments,
  removeReviewAmendments,
  removeReviewDocument,
  reviewGroupSize,
  reviewQueueKey,
} from "~/components/review/-queue";
import { affectsReviewQueue } from "~/components/review/-live";

/**
 * The Secretaría's validation inbox (GET .../review): presented documents
 * and amendments that nobody else sees until they are validated, the
 * transactionals still waiting for the main authors of the amendments they
 * would replace (with who is missing; one any of them rejected is gone),
 * the amendments validated but kept private and, in "Fuera de plazo", the
 * late ones that wait for the assembly to decide whether to treat them.
 * Documents need document:manage, amendments amendment:review; each part
 * shows only to whoever holds it.
 *
 * The queue shares its fetch key with the hub, which keeps the "Validación"
 * badge and starts the fetch if the permission arrives after setup; every
 * action patches it at once and refetches in the background.
 */

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { can } = useMe();
const current = useCurrentAssembly();
const { assembly, apiBase, sectionPath, onLive } = current;

useHead({
  title: () =>
    [t("review.title"), assembly.value?.label].filter(Boolean).join(" · "),
});

const canDocuments = computed(() => can(PERMISSION_KEYS.DOCUMENT_MANAGE));
const canAmendments = computed(() => can(PERMISSION_KEYS.AMENDMENT_REVIEW));
const allowed = computed(() => canDocuments.value || canAmendments.value);

const result = useFetch<ReviewQueueDto>(() => `${apiBase.value}/review`, {
  key: computed(() => reviewQueueKey(assembly.value?.id ?? "none")),
  immediate: allowed.value,
  dedupe: "defer",
});
const { data: queue, stale } = keepLastGoodData(result, {
  resetOn: () => assembly.value?.id,
});
useStaleDataNotice(stale);
const { pending, error } = result;
await result;

function refresh(): Promise<void> {
  if (!allowed.value) return Promise.resolve();
  return result.refresh({ dedupe: "defer" });
}

onLive((events) => {
  if (affectsReviewQueue(events)) void refresh();
});

const documents = computed<DocumentSummaryDto[]>(() =>
  canDocuments.value ? (queue.value?.documents ?? []) : [],
);
const groups = computed(() =>
  canAmendments.value
    ? groupReviewAmendments(queue.value?.amendments ?? [])
    : [],
);
/** Documents with amendments to check now (validate, publish, wait). */
const reviewGroups = computed(() =>
  groups.value.filter((group) => reviewGroupSize(group) > 0),
);
/** Documents with late amendments waiting for the assembly. */
const lateGroups = computed(() =>
  groups.value.filter((group) => group.late.length > 0),
);
const amendmentCount = computed(() =>
  reviewGroups.value.reduce(
    (total, group) => total + reviewGroupSize(group),
    0,
  ),
);
const lateCount = computed(() =>
  lateGroups.value.reduce((total, group) => total + group.late.length, 0),
);
const empty = computed(
  () =>
    documents.value.length === 0 &&
    amendmentCount.value === 0 &&
    lateCount.value === 0,
);

const settings = computed(() => ({
  ...DEFAULT_ASSEMBLY_SETTINGS,
  ...assembly.value?.settings,
}));

function documentPath(slug: string): string {
  return sectionPath(`documentos/${encodeURIComponent(slug)}`);
}

const statusMessage = ref("");

function announce(message: string) {
  statusMessage.value = message;
}

function patch(update: (value: ReviewQueueDto) => ReviewQueueDto) {
  if (queue.value) queue.value = update(queue.value);
}

function onAmendmentsUpdated(amendments: AmendmentDto[]) {
  patch((value) => applyAmendmentResults(value, amendments));
  void refresh();
}

function onAmendmentsRemoved(ids: string[]) {
  patch((value) => removeReviewAmendments(value, ids));
  void refresh();
}

// Documents -------------------------------------------------------------------

const documentBusy = ref<{
  id: string;
  action: "publish" | "correction";
} | null>(null);

const publishTarget = ref<DocumentSummaryDto | null>(null);
const publishOpen = computed({
  get: () => publishTarget.value !== null,
  set: (open: boolean) => {
    if (!open && documentBusy.value?.action !== "publish") {
      publishTarget.value = null;
    }
  },
});

const correctionTarget = ref<DocumentSummaryDto | null>(null);
const correctionOpen = computed({
  get: () => correctionTarget.value !== null,
  set: (open: boolean) => {
    if (!open && documentBusy.value?.action !== "correction") {
      correctionTarget.value = null;
    }
  },
});

function documentUrl(document: DocumentSummaryDto): string {
  return `${apiBase.value}/documents/${encodeURIComponent(document.id)}`;
}

async function confirmPublish() {
  const document = publishTarget.value;
  if (!document || documentBusy.value) return;
  documentBusy.value = { id: document.id, action: "publish" };
  try {
    const published = await api.send<DocumentDto>(
      `${documentUrl(document)}/publish`,
      { method: "POST", body: { updatedAt: document.updatedAt } },
    );
    documentBusy.value = null;
    publishTarget.value = null;
    patch((value) => removeReviewDocument(value, document.id));
    const title = t("review.documents.published", { title: published.title });
    const description = published.reference
      ? t("review.documents.publishedReference", {
          reference: published.reference,
        })
      : undefined;
    announce(description ? `${title}. ${description}` : title);
    toast.add({ title, description, color: "success", icon: "i-lucide-check" });
    void refresh();
  } catch (failure) {
    documentBusy.value = null;
    api.notifyError(failure, "review.documents.publishError");
    if (api.isConflict(failure)) {
      publishTarget.value = null;
      await refresh();
    }
  }
}

async function sendDocumentCorrection(note: string) {
  const document = correctionTarget.value;
  if (!document || documentBusy.value) return;
  documentBusy.value = { id: document.id, action: "correction" };
  try {
    const body: CorrectionBody = { note, updatedAt: document.updatedAt };
    await api.send<DocumentDto>(`${documentUrl(document)}/correction`, {
      method: "POST",
      body,
    });
    documentBusy.value = null;
    correctionTarget.value = null;
    patch((value) => removeReviewDocument(value, document.id));
    const title = t("review.documents.correctionSent", {
      title: document.title,
    });
    const description = t("review.documents.correctionHint");
    announce(`${title}. ${description}`);
    toast.add({
      title,
      description,
      color: "success",
      icon: "i-lucide-undo-2",
    });
    void refresh();
  } catch (failure) {
    documentBusy.value = null;
    api.notifyError(failure, "review.documents.correctionError");
    if (api.isConflict(failure)) {
      correctionTarget.value = null;
      await refresh();
    }
  }
}

function documentBusyFor(id: string): "publish" | "correction" | null {
  return documentBusy.value?.id === id ? documentBusy.value.action : null;
}
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <CommonEmptyState
      v-if="!allowed"
      icon="i-lucide-shield-x"
      :title="t('review.forbiddenTitle')"
      :description="t('review.forbiddenDescription')"
      variant="outline"
    >
      <template #action>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('review.backToOverview')"
          :to="sectionPath()"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <h2 class="text-highlighted text-xl font-semibold">
            {{ t("review.title") }}
          </h2>
          <p class="text-muted max-w-3xl text-sm">{{ t("review.intro") }}</p>
        </div>
        <UButton
          v-if="canDocuments"
          color="neutral"
          variant="outline"
          icon="i-lucide-list-checks"
          :label="t('review.toTracking')"
          :to="sectionPath('seguimiento')"
        />
      </div>

      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ statusMessage }}
      </p>

      <div
        v-if="pending && !queue"
        class="space-y-3"
        aria-busy="true"
        :aria-label="t('review.loading')"
      >
        <USkeleton v-for="n in 3" :key="n" class="h-28 w-full" />
      </div>

      <UAlert
        v-else-if="error && !queue"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('review.loadError')"
        :actions="[
          {
            label: t('review.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => {
              void refresh();
            },
          },
        ]"
        role="alert"
      />

      <CommonEmptyState
        v-else-if="empty"
        icon="i-lucide-circle-check-big"
        :title="t('review.emptyTitle')"
        :description="t('review.emptyDescription')"
        variant="outline"
      >
        <template v-if="canDocuments" #action>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-list-checks"
            :label="t('review.toTracking')"
            :to="sectionPath('seguimiento')"
          />
        </template>
      </CommonEmptyState>

      <template v-else>
        <section
          v-if="canDocuments"
          class="space-y-3"
          aria-labelledby="review-documents-heading"
        >
          <h3
            id="review-documents-heading"
            class="text-highlighted flex items-center gap-2 text-lg font-semibold"
          >
            {{ t("review.documents.title") }}
            <UBadge
              color="neutral"
              variant="soft"
              size="sm"
              :label="String(documents.length)"
            />
          </h3>
          <p v-if="documents.length === 0" class="text-muted text-sm">
            {{ t("review.documents.none") }}
          </p>
          <ul v-else class="space-y-3">
            <li v-for="document in documents" :key="document.id">
              <ReviewDocumentCard
                :document="document"
                :to="documentPath(document.slug)"
                :busy="documentBusyFor(document.id)"
                :disabled="documentBusy !== null"
                @publish="publishTarget = document"
                @correction="correctionTarget = document"
              />
            </li>
          </ul>
        </section>

        <section
          v-if="canAmendments"
          class="space-y-4"
          aria-labelledby="review-amendments-heading"
        >
          <div class="space-y-1">
            <h3
              id="review-amendments-heading"
              class="text-highlighted flex items-center gap-2 text-lg font-semibold"
            >
              {{ t("review.amendments.title") }}
              <UBadge
                color="neutral"
                variant="soft"
                size="sm"
                :label="String(amendmentCount)"
              />
            </h3>
            <p v-if="amendmentCount > 0" class="text-muted text-sm">
              {{ t("review.amendments.help") }}
            </p>
          </div>
          <p v-if="amendmentCount === 0" class="text-muted text-sm">
            {{ t("review.amendments.none") }}
          </p>
          <div v-else class="space-y-8">
            <ReviewAmendmentGroup
              v-for="group in reviewGroups"
              :key="group.document.id"
              :group="group"
              :api-base="apiBase"
              :assembly-id="assembly.id"
              :document-path="documentPath(group.document.slug)"
              @updated="onAmendmentsUpdated"
              @removed="onAmendmentsRemoved"
              @conflict="refresh"
              @announce="announce"
            />
          </div>
        </section>

        <section
          v-if="canAmendments && lateCount > 0"
          class="space-y-4"
          aria-labelledby="review-late-heading"
        >
          <div class="space-y-1">
            <h3
              id="review-late-heading"
              class="text-highlighted flex items-center gap-2 text-lg font-semibold"
            >
              <UIcon
                name="i-lucide-clock-alert"
                class="text-warning size-5 shrink-0"
                aria-hidden="true"
              />
              {{ t("review.late.title") }}
              <UBadge
                color="warning"
                variant="soft"
                size="sm"
                :label="String(lateCount)"
              />
            </h3>
            <p class="text-muted max-w-3xl text-sm">
              {{ t("review.late.intro") }}
            </p>
          </div>
          <div class="space-y-8">
            <ReviewLateGroup
              v-for="group in lateGroups"
              :key="group.document.id"
              :group="group"
              :api-base="apiBase"
              :assembly-id="assembly.id"
              :document-path="documentPath(group.document.slug)"
              :settings="settings"
              @updated="onAmendmentsUpdated"
              @removed="onAmendmentsRemoved"
              @conflict="refresh"
              @announce="announce"
            />
          </div>
        </section>
      </template>

      <UModal
        v-model:open="publishOpen"
        :title="t('review.documents.confirmTitle')"
        :description="publishTarget?.title"
        :dismissible="documentBusy === null"
      >
        <template #body>
          <ul class="space-y-2 text-sm">
            <li class="flex items-start gap-2">
              <UIcon
                name="i-lucide-eye"
                class="text-muted mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {{ t("review.documents.confirmVisible") }}
            </li>
            <li class="flex items-start gap-2">
              <UIcon
                name="i-lucide-lock"
                class="text-muted mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {{ t("review.documents.confirmFrozen") }}
            </li>
            <li v-if="publishTarget?.amendable" class="flex items-start gap-2">
              <UIcon
                name="i-lucide-message-square-diff"
                class="text-muted mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {{ t("review.documents.confirmAmendments") }}
            </li>
          </ul>
        </template>
        <template #footer>
          <div class="flex w-full flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="t('common.cancel')"
              :disabled="documentBusy !== null"
              @click="publishOpen = false"
            />
            <UButton
              icon="i-lucide-check-check"
              :label="t('review.documents.publish')"
              :loading="documentBusy?.action === 'publish'"
              @click="confirmPublish"
            />
          </div>
        </template>
      </UModal>

      <ReviewCorrectionModal
        v-model:open="correctionOpen"
        kind="document"
        :subject="correctionTarget?.title ?? ''"
        :busy="documentBusy?.action === 'correction'"
        @confirm="sendDocumentCorrection"
      />
    </template>
  </div>
</template>
