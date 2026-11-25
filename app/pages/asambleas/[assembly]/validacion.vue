<script setup lang="ts">
import type { TabsItem } from "@nuxt/ui";
import {
  reviewsAmendments,
  usesReviewQueue,
  validatesDocuments,
} from "~~/shared/utils/permissionRules";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  type MilestoneKey,
} from "~~/shared/constants/domain";
import type {
  AmendmentDto,
  CorrectionBody,
  MemberRef,
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
  splitReviewParts,
} from "~/components/review/-queue";
import {
  affectsReviewQueue,
  refetchesAfterWrite,
} from "~/components/review/-live";
import { sentAfterDeadline } from "~~/shared/utils/documentDeadline";

/**
 * The Secretaría's validation inbox (GET .../review): presented documents;
 * then "Transaccionales", a section of their own (user's decision of
 * 2026-11-19): those to validate and those still waiting for the main
 * authors of the amendments they would replace (with who is missing; one
 * any of them rejected is gone); then "Enmiendas" in three tabs: "Por
 * revisar", the amendments nobody else sees until they are validated, and
 * "Sin publicar",
 * the amendments it validated and kept private, to publish them, and
 * "Publicadas", those validated and published still undecided, to take a
 * validation made by mistake back (user's decision of 2026-11-20); and, in
 * "Fuera de plazo",
 * the late ones that wait for the assembly to decide whether to treat them.
 * Validating a transactional always publishes it: it replaces amendments
 * that are already public, and the help says so while one is listed.
 * Documents need document:manage, amendments amendment:review (or
 * amendment:manage, which holds it); each part shows only to whoever holds
 * it (permissionRules.ts, as the server reads it).
 *
 * The queue shares its fetch key with the hub, which keeps the "Validación"
 * badge and starts the fetch if the permission arrives after setup; every
 * action patches it at once and replaces any read already on its way, which
 * may have left before the action; the action's own live event refetches
 * it (refetchesAfterWrite).
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

const canDocuments = computed(() => validatesDocuments(can));
const canAmendments = computed(() => reviewsAmendments(can));
const allowed = computed(() => usesReviewQueue(can));

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

/**
 * The queue again, at once (a conflict, «Reintentar», a validation taken
 * back from the validated list, whose card the queue does not hold yet): a
 * read on its way may have left before what changed it and is replaced,
 * never joined.
 */
function refresh(): Promise<void> {
  if (!allowed.value) return Promise.resolve();
  return result.refresh({ dedupe: "cancel" });
}

/**
 * After a write of this page, already patched in: only a read on its way
 * is replaced, which would bring the old queue back when it lands; the
 * write's live event refetches the queue otherwise (refetchesAfterWrite).
 */
function refreshAfterWrite(): void {
  if (
    refetchesAfterWrite({
      status: result.status.value,
      connected: current.live.connected.value,
    })
  ) {
    void refresh();
  }
}

// A live batch never joins a read that may have left before it either; the
// hub's subscriber to the same queue shares the run (liveRefresh).
onLive((events) => {
  if (!allowed.value || !affectsReviewQueue(events)) return;
  void current.liveRefresh(reviewQueueKey(assembly.value?.id ?? "none"), () =>
    result.refresh({ dedupe: "cancel" }),
  );
});

const allDocuments = computed<DocumentSummaryDto[]>(() =>
  canDocuments.value ? (queue.value?.documents ?? []) : [],
);
const allAmendments = computed(() =>
  canAmendments.value ? (queue.value?.amendments ?? []) : [],
);

// Filters (user's decision of 2026-11-20) ----------------------------------------

/** One document, or one member who presents (a document or an amendment). */
const filterDocumentId = ref<string | undefined>(undefined);
const filterMemberId = ref<string | undefined>(undefined);
const filtering = computed(
  () =>
    filterDocumentId.value !== undefined || filterMemberId.value !== undefined,
);
function clearFilters(): void {
  filterDocumentId.value = undefined;
  filterMemberId.value = undefined;
}
/** Below sm the label is only read (the menu's `aria-label` names it). */
const filterFieldUi = { wrapper: "max-sm:sr-only", container: "max-sm:mt-0" };

/** Every document with something here, by its reference and title. */
const documentFilterItems = computed(() => {
  const seen = new Map<string, string>();
  for (const document of allDocuments.value) {
    seen.set(document.id, documentFilterLabel(document));
  }
  for (const row of allAmendments.value) {
    if (!seen.has(row.document.id)) {
      seen.set(row.document.id, documentFilterLabel(row.document));
    }
  }
  return [...seen].map(([value, label]) => ({ value, label }));
});
function documentFilterLabel(document: {
  title: string;
  reference: string | null;
}): string {
  return document.reference
    ? `${document.reference} · ${document.title}`
    : document.title;
}

/** Every member presenting something here, by acronym. */
const memberFilterItems = computed(() => {
  const seen = new Map<string, { label: string; acronym: string }>();
  const add = (member: MemberRef | null | undefined) => {
    if (member && !seen.has(member.id)) {
      seen.set(member.id, {
        label: `${member.acronym} · ${member.name}`,
        acronym: member.acronym,
      });
    }
  };
  for (const document of allDocuments.value) {
    add(document.proponent);
    document.coProponents.forEach(add);
  }
  for (const row of allAmendments.value) row.amendment.authors.forEach(add);
  return [...seen]
    .map(([value, entry]) => ({ value, ...entry }))
    .sort((a, b) => a.acronym.localeCompare(b.acronym));
});

const documents = computed<DocumentSummaryDto[]>(() =>
  allDocuments.value.filter(
    (document) =>
      (filterDocumentId.value === undefined ||
        document.id === filterDocumentId.value) &&
      (filterMemberId.value === undefined ||
        [document.proponent, ...document.coProponents].some(
          (member) => member?.id === filterMemberId.value,
        )),
  ),
);
const groups = computed(() =>
  groupReviewAmendments(
    allAmendments.value.filter(
      (row) =>
        (filterDocumentId.value === undefined ||
          row.document.id === filterDocumentId.value) &&
        (filterMemberId.value === undefined ||
          row.amendment.authors.some(
            (author) => author.id === filterMemberId.value,
          )),
    ),
  ),
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
/**
 * Amendments in two parts: not reviewed yet, and validated without
 * publishing, each with its own documents.
 */
const parts = computed(() => splitReviewParts(reviewGroups.value));
/**
 * What the "Por revisar" badge counts: those to validate. Transactionals
 * waiting for their authors are listed, but nothing can be done with them
 * yet (as on the home page); `toReviewListed` counts them too.
 */
const toValidateCount = computed(() =>
  parts.value.toReview.reduce(
    (total, group) => total + group.toValidate.length,
    0,
  ),
);
const toReviewListed = computed(() =>
  parts.value.toReview.reduce(
    (total, group) =>
      total + group.toValidate.length + group.awaitingAuthors.length,
    0,
  ),
);
const toPublishCount = computed(() =>
  parts.value.toPublish.reduce(
    (total, group) => total + group.toPublish.length,
    0,
  ),
);

/**
 * The parts are tabs of "Enmiendas": «Por revisar» and «Sin publicar» with
 * their counts, and «Publicadas» (the validated and published ones still
 * undecided, to take a validation back) without one: it is read only when
 * opened, and a count appearing then widened the strip (E-159). No two
 * labels start alike, and below sm the strip scrolls instead of cutting
 * them (as the control sheet's).
 */
type AmendmentTab = "review" | "publish" | "validated";
const amendmentTab = ref<AmendmentTab>("review");
const amendmentTabItems = computed<TabsItem[]>(() => [
  {
    value: "review",
    label: t("review.amendments.tabs.review"),
    badge: {
      label: String(toValidateCount.value),
      color: "neutral",
      variant: "soft",
    },
  },
  {
    value: "publish",
    label: t("review.amendments.tabs.publish"),
    badge: {
      label: String(toPublishCount.value),
      color: "neutral",
      variant: "soft",
    },
  },
  { value: "validated", label: t("review.amendments.tabs.validated") },
]);
/** The transactionals listed apart: to validate, and waiting for authors. */
const transactionalsToValidate = computed(() =>
  parts.value.transactionals.reduce(
    (total, group) => total + group.toValidate.length,
    0,
  ),
);
const transactionalsListed = computed(() =>
  parts.value.transactionals.reduce(
    (total, group) =>
      total + group.toValidate.length + group.awaitingAuthors.length,
    0,
  ),
);
const lateCount = computed(() =>
  lateGroups.value.reduce((total, group) => total + group.late.length, 0),
);
/** Corrections of form to approved texts proposed by their presenters. */
const formCorrections = computed(() =>
  canDocuments.value ? (queue.value?.formCorrections ?? []) : [],
);

/** Nothing waits at all; filtered away, the sections say so one by one. */
const empty = computed(
  () =>
    !filtering.value &&
    documents.value.length === 0 &&
    formCorrections.value.length === 0 &&
    amendmentCount.value === 0 &&
    lateCount.value === 0,
);

/**
 * A validation taken back from the list shown under «Todo al día» brings
 * the amendment back to review, so the page swaps to its sections and that
 * list (its dialog and what it would focus) goes: the focus goes to the
 * section that now lists it, not to the top of the page. A transactional
 * comes back under «Transaccionales»; any other under «Enmiendas», whose tab
 * is set back to «Por revisar» (it may have been left on an emptied one).
 * The flag lives only until that refresh settles, so a later swap the user
 * did not cause (a live event) never pulls the focus.
 */
const amendmentsHeading = ref<HTMLElement | null>(null);
const transactionalsHeading = ref<HTMLElement | null>(null);
let undoneWhileEmpty: AmendmentDto["kind"] | null = null;
// A second undo cancels the first one's read: only its own settling clears.
let lastUndo = 0;
function onUndoneWhileEmpty(amendment: AmendmentDto): void {
  const undo = ++lastUndo;
  undoneWhileEmpty = amendment.kind;
  amendmentTab.value = "review";
  void refresh().finally(() => {
    if (undo === lastUndo) undoneWhileEmpty = null;
  });
}
watch(empty, (now) => {
  if (now || undoneWhileEmpty === null) return;
  const heading =
    undoneWhileEmpty === "transactional"
      ? transactionalsHeading
      : amendmentsHeading;
  undoneWhileEmpty = null;
  void nextTick(() => (heading.value ?? amendmentsHeading.value)?.focus());
});

const settings = computed(() => ({
  ...DEFAULT_ASSEMBLY_SETTINGS,
  ...assembly.value?.settings,
}));

function documentPath(slug: string): string {
  return sectionPath(`documentos/${encodeURIComponent(slug)}`);
}

function patch(update: (value: ReviewQueueDto) => ReviewQueueDto) {
  if (queue.value) queue.value = update(queue.value);
}

function onAmendmentsUpdated(amendments: AmendmentDto[]) {
  patch((value) => applyAmendmentResults(value, amendments));
  refreshAfterWrite();
}

function onAmendmentsRemoved(ids: string[]) {
  patch((value) => removeReviewAmendments(value, ids));
  refreshAfterWrite();
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
    toast.add({ title, description, color: "success", icon: "i-lucide-check" });
    refreshAfterWrite();
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
    toast.add({
      title,
      description,
      color: "success",
      icon: "i-lucide-undo-2",
    });
    refreshAfterWrite();
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

function milestoneAt(key: MilestoneKey): string | null {
  return (
    assembly.value?.milestones.find((milestone) => milestone.key === key)?.at ??
    null
  );
}

/**
 * Sent after its deadline (`documentDeadlineKey`: reports have their own,
 * `reports_close`): marked late, so the Secretaría and the Mesa know. The
 * card adds that the assembly has to agree to treat it, except for a
 * report (`lateNeedsAssembly`).
 */
function sentLate(document: DocumentSummaryDto): boolean {
  return sentAfterDeadline(document, milestoneAt);
}

// Several documents at once --------------------------------------------------

const selectedDocuments = ref<Set<string>>(new Set());
const bulkPublishing = ref(false);
const bulkOpen = ref(false);

watch(documents, (list) => {
  const present = new Set(list.map((document) => document.id));
  const kept = [...selectedDocuments.value].filter((id) => present.has(id));
  if (kept.length !== selectedDocuments.value.size) {
    selectedDocuments.value = new Set(kept);
  }
});

const selectedDocumentList = computed(() =>
  documents.value.filter((document) =>
    selectedDocuments.value.has(document.id),
  ),
);
const allDocumentsSelected = computed<boolean | "indeterminate">(() => {
  const count = selectedDocumentList.value.length;
  if (count === 0) return false;
  return count === documents.value.length ? true : "indeterminate";
});
const selectedDocumentsMessage = computed(() =>
  selectedDocumentList.value.length > 0
    ? t(
        "review.documents.selected",
        { count: selectedDocumentList.value.length },
        selectedDocumentList.value.length,
      )
    : "",
);

function toggleAllDocuments(value: boolean | "indeterminate") {
  selectedDocuments.value =
    value === true
      ? new Set(documents.value.map((document) => document.id))
      : new Set();
}

function toggleDocument(id: string, value: boolean) {
  const next = new Set(selectedDocuments.value);
  if (value) next.add(id);
  else next.delete(id);
  selectedDocuments.value = next;
}

/**
 * Validates and publishes the selected documents one after another, as the
 * single action does, and says which ones failed (a conflict means someone
 * changed it meanwhile; the queue is refreshed to show the current state).
 */
async function confirmBulkPublish() {
  const targets = selectedDocumentList.value;
  if (targets.length === 0 || bulkPublishing.value || documentBusy.value)
    return;
  bulkPublishing.value = true;
  const failed: string[] = [];
  let published = 0;
  for (const document of targets) {
    documentBusy.value = { id: document.id, action: "publish" };
    try {
      await api.send<DocumentDto>(`${documentUrl(document)}/publish`, {
        method: "POST",
        body: { updatedAt: document.updatedAt },
      });
      published++;
      // The publications' live events refetch the queue one run after
      // another meanwhile (liveRefresh); the end replaces a read still on
      // its way, which may have left before the last ones.
      patch((value) => removeReviewDocument(value, document.id));
    } catch {
      failed.push(document.title);
    }
  }
  documentBusy.value = null;
  bulkPublishing.value = false;
  bulkOpen.value = false;
  selectedDocuments.value = new Set();
  if (published > 0) {
    const title = t(
      "review.documents.bulkPublished",
      { count: published },
      published,
    );
    toast.add({ title, color: "success", icon: "i-lucide-check" });
  }
  if (failed.length > 0) {
    toast.add({
      title: t("review.documents.publishError"),
      description: t("review.documents.bulkFailed", {
        titles: failed.join(", "),
      }),
      color: "error",
      icon: "i-lucide-circle-alert",
    });
  }
  // A failure (someone changed the document meanwhile) shows the queue as
  // it stands now, as a single conflict does.
  if (failed.length > 0) void refresh();
  else refreshAfterWrite();
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
    />

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

      <!-- Narrow everything below to one document or one presenter. On a
           phone, one row: the labels are read, not shown (the placeholders
           say «Todos los documentos» and «Todos»), and «Quitar filtros» is
           its icon. -->
      <div
        v-if="queue && (documentFilterItems.length > 1 || filtering)"
        class="grid items-end gap-2 sm:flex sm:flex-wrap sm:gap-3"
        :class="
          filtering
            ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]'
            : 'grid-cols-2'
        "
      >
        <UFormField
          :label="t('review.filters.document')"
          class="min-w-0 sm:w-80"
          :ui="filterFieldUi"
        >
          <USelectMenu
            v-model="filterDocumentId"
            :items="documentFilterItems"
            value-key="value"
            :placeholder="t('review.filters.allDocuments')"
            :search-input="labelledSearch(t('review.filters.search'))"
            :aria-label="
              selectMenuLabel(
                t('review.filters.document'),
                documentFilterItems,
                filterDocumentId,
                t('review.filters.allDocuments'),
              )
            "
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('review.filters.member')"
          class="min-w-0 sm:w-64"
          :ui="filterFieldUi"
        >
          <USelectMenu
            v-model="filterMemberId"
            :items="memberFilterItems"
            value-key="value"
            :filter-fields="['label', 'acronym']"
            :placeholder="t('review.filters.allMembers')"
            :search-input="labelledSearch(t('review.filters.search'))"
            :aria-label="
              selectMenuLabel(
                t('review.filters.member'),
                memberFilterItems,
                filterMemberId,
                t('review.filters.allMembers'),
              )
            "
            class="w-full"
          />
        </UFormField>
        <UButton
          v-if="filtering"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          :label="t('review.filters.clear')"
          :ui="{ label: 'max-sm:sr-only' }"
          @click="clearFilters"
        />
      </div>

      <!-- Corrections of form proposed to approved texts. -->
      <UAlert
        v-if="formCorrections.length > 0"
        color="warning"
        variant="subtle"
        icon="i-lucide-spell-check"
        :title="t('review.formCorrections.title')"
      >
        <template #description>
          <ul class="mt-1 space-y-1">
            <li v-for="entry in formCorrections" :key="entry.document.id">
              <ULink
                :to="`${documentPath(entry.document.slug)}/consolidado`"
                class="text-highlighted font-medium underline underline-offset-2"
              >
                {{ entry.document.title }}
              </ULink>
              <span class="text-muted">
                ·
                {{
                  t(
                    "review.formCorrections.count",
                    { count: entry.count },
                    entry.count,
                  )
                }}
              </span>
            </li>
          </ul>
        </template>
      </UAlert>

      <div v-if="pending && !queue" class="space-y-3" role="status">
        <span class="sr-only">{{ t("review.loading") }}</span>
        <USkeleton
          v-for="n in 3"
          :key="n"
          aria-hidden="true"
          class="h-28 w-full"
        />
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

      <template v-else-if="empty">
        <CommonEmptyState
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
        <!-- Nothing left to review: what was validated can still go back. -->
        <section
          v-if="canAmendments"
          class="space-y-4"
          aria-labelledby="review-validated-heading"
        >
          <h3
            id="review-validated-heading"
            class="text-highlighted text-lg font-semibold"
          >
            {{ t("review.validated.title") }}
          </h3>
          <ReviewValidatedList
            active
            :api-base="apiBase"
            :assembly-id="assembly.id"
            :document-path="documentPath"
            :document-id="filterDocumentId"
            :member-id="filterMemberId"
            @undone="onUndoneWhileEmpty"
          />
        </section>
      </template>

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
              size="md"
              :label="String(documents.length)"
            />
          </h3>
          <p v-if="documents.length === 0" class="text-muted text-sm">
            {{ t("review.documents.none") }}
          </p>
          <template v-else>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-muted flex items-start gap-1.5 text-sm">
                <UIcon
                  name="i-lucide-eye-off"
                  class="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{{ t("review.documents.waitingAll") }}</span>
              </p>
              <UCheckbox
                v-if="documents.length > 1"
                :model-value="allDocumentsSelected"
                :label="t('review.documents.selectAll')"
                :disabled="bulkPublishing"
                @update:model-value="toggleAllDocuments"
              />
            </div>

            <p
              class="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {{ selectedDocumentsMessage }}
            </p>

            <div
              v-if="selectedDocumentList.length > 0"
              class="border-primary/40 bg-primary/5 sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border p-2"
              role="group"
              :aria-label="t('review.documents.bulkLabel')"
            >
              <span class="text-highlighted px-1 text-sm font-medium">
                {{ selectedDocumentsMessage }}
              </span>
              <UButton
                size="sm"
                icon="i-lucide-check-check"
                :label="
                  t('review.documents.bulkPublish', {
                    count: selectedDocumentList.length,
                  })
                "
                :loading="bulkPublishing"
                :disabled="documentBusy !== null && !bulkPublishing"
                @click="bulkOpen = true"
              />
            </div>

            <ul class="space-y-3">
              <li v-for="document in documents" :key="document.id">
                <ReviewDocumentCard
                  :document="document"
                  :to="documentPath(document.slug)"
                  :busy="documentBusyFor(document.id)"
                  :disabled="documentBusy !== null"
                  :late="sentLate(document)"
                  :selectable="documents.length > 1"
                  :selected="selectedDocuments.has(document.id)"
                  @select="toggleDocument(document.id, $event)"
                  @publish="publishTarget = document"
                  @correction="correctionTarget = document"
                />
              </li>
            </ul>
          </template>
        </section>

        <!-- Transactionals: validating one publishes it and replaces the
             amendments it groups, so they are never mixed with the rest. -->
        <section
          v-if="canAmendments && transactionalsListed > 0"
          class="sm:border-primary/30 sm:bg-primary/5 space-y-4 sm:rounded-xl sm:border sm:p-5"
          aria-labelledby="review-transactionals-heading"
        >
          <div class="space-y-1">
            <h3
              id="review-transactionals-heading"
              ref="transactionalsHeading"
              tabindex="-1"
              class="text-highlighted flex items-center gap-2 text-lg font-semibold outline-none"
            >
              <UIcon
                name="i-lucide-merge"
                class="text-primary size-5 shrink-0"
                aria-hidden="true"
              />
              {{ t("review.transactionals.title") }}
              <UBadge
                color="primary"
                variant="soft"
                size="md"
                :label="String(transactionalsToValidate)"
                :aria-label="
                  t(
                    'review.transactionals.toValidate',
                    { count: transactionalsToValidate },
                    transactionalsToValidate,
                  )
                "
              />
            </h3>
            <p class="text-default max-w-3xl text-sm">
              {{ t("review.amendments.transactionalsPublished") }}
            </p>
          </div>
          <div class="space-y-8">
            <ReviewAmendmentGroup
              v-for="group in parts.transactionals"
              :key="group.document.id"
              :group="group"
              :api-base="apiBase"
              :assembly-id="assembly.id"
              :document-path="documentPath(group.document.slug)"
              @updated="onAmendmentsUpdated"
              @removed="onAmendmentsRemoved"
              @conflict="refresh"
            />
          </div>
        </section>

        <section
          v-if="canAmendments"
          class="space-y-4"
          aria-labelledby="review-amendments-heading"
        >
          <h3
            id="review-amendments-heading"
            ref="amendmentsHeading"
            tabindex="-1"
            class="text-highlighted text-lg font-semibold outline-none"
          >
            {{ t("review.amendments.title") }}
          </h3>
          <UTabs
            v-model="amendmentTab"
            :items="amendmentTabItems"
            :content="false"
            variant="link"
            class="w-full"
            :ui="{
              list: 'max-sm:overflow-x-auto max-sm:overflow-y-hidden',
              indicator: 'max-sm:bottom-0',
              trigger: 'max-sm:shrink-0',
              label: 'max-sm:overflow-visible max-sm:whitespace-nowrap',
              trailingBadgeSize: 'md',
            }"
            :aria-label="t('review.amendments.tabs.label')"
          />

          <!-- Both stay mounted: switching never fetches the texts again. -->
          <div v-show="amendmentTab === 'review'" class="space-y-4">
            <p v-if="toReviewListed > 0" class="text-muted max-w-3xl text-sm">
              {{ t("review.amendments.help") }}
            </p>
            <p v-else class="text-muted text-sm">
              {{ t("review.amendments.none") }}
            </p>
            <div v-if="toReviewListed > 0" class="space-y-8">
              <ReviewAmendmentGroup
                v-for="group in parts.toReview"
                :key="group.document.id"
                :group="group"
                :api-base="apiBase"
                :assembly-id="assembly.id"
                :document-path="documentPath(group.document.slug)"
                @updated="onAmendmentsUpdated"
                @removed="onAmendmentsRemoved"
                @conflict="refresh"
              />
            </div>
          </div>

          <div v-show="amendmentTab === 'publish'" class="space-y-4">
            <p v-if="toPublishCount > 0" class="text-muted max-w-3xl text-sm">
              {{ t("review.toPublish.help") }}
            </p>
            <p v-else class="text-muted text-sm">
              {{ t("review.toPublish.none") }}
            </p>
            <div v-if="toPublishCount > 0" class="space-y-8">
              <ReviewAmendmentGroup
                v-for="group in parts.toPublish"
                :key="group.document.id"
                :group="group"
                :api-base="apiBase"
                :assembly-id="assembly.id"
                :document-path="documentPath(group.document.slug)"
                @updated="onAmendmentsUpdated"
                @removed="onAmendmentsRemoved"
                @conflict="refresh"
              />
            </div>
          </div>

          <!-- Read only when opened: it can list every amendment. -->
          <ReviewValidatedList
            v-show="amendmentTab === 'validated'"
            :active="amendmentTab === 'validated'"
            :api-base="apiBase"
            :assembly-id="assembly.id"
            :document-path="documentPath"
            :document-id="filterDocumentId"
            :member-id="filterMemberId"
            @undone="refresh"
          />
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
                size="md"
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

      <UModal
        v-model:open="bulkOpen"
        :title="
          t(
            'review.documents.bulkConfirmTitle',
            { count: selectedDocumentList.length },
            selectedDocumentList.length,
          )
        "
        :dismissible="!bulkPublishing"
      >
        <template #body>
          <ul class="mb-4 list-disc space-y-1 ps-5 text-sm">
            <li v-for="document in selectedDocumentList" :key="document.id">
              {{ document.title }}
            </li>
          </ul>
          <ul class="space-y-2 text-sm">
            <li class="flex items-start gap-2">
              <UIcon
                name="i-lucide-eye"
                class="text-muted mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {{ t("review.documents.bulkConfirmVisible") }}
            </li>
            <li class="flex items-start gap-2">
              <UIcon
                name="i-lucide-lock"
                class="text-muted mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {{ t("review.documents.bulkConfirmFrozen") }}
            </li>
          </ul>
        </template>
        <template #footer>
          <div class="flex w-full flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="t('common.cancel')"
              :disabled="bulkPublishing"
              @click="bulkOpen = false"
            />
            <UButton
              icon="i-lucide-check-check"
              :label="
                t('review.documents.bulkPublish', {
                  count: selectedDocumentList.length,
                })
              "
              :loading="bulkPublishing"
              @click="confirmBulkPublish"
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
