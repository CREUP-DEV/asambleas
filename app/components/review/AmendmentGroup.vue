<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  PublishAmendmentsBody,
  ValidateAmendmentsBody,
  CorrectionBody,
} from "~~/shared/types/api";
import {
  blockedBySelection,
  canSelectSeveral,
  isSelectionFull,
  selectAllReviewIds,
  selectableReviewIds,
  splitReviewSelection,
  type ReviewAmendmentAction,
  type ReviewDocumentGroup,
} from "./-queue";

/**
 * The amendments of one document in one part of the validation inbox
 * (splitReviewParts): in the "Por revisar" tab, those waiting for
 * validation and the transactionals still waiting for the main authors of
 * the amendments they would replace (shown with who is missing, not
 * actionable); in the "Validadas sin publicar" tab, those validated but kept
 * private. Each with its changes over the published text (fetched once per
 * document). When there are several, they can be selected to validate or
 * publish them at once: the endpoints work per document. Late ones waiting
 * for the assembly are listed apart (LateGroup).
 *
 * A transactional names the amendments it groups: they are published, so
 * not in the queue, and the document's amendment list is loaded for their
 * codes only while the group has a transactional. Validating one always
 * publishes it, since it replaces public amendments: "Validar sin
 * publicar" leaves transactionals out. Two transactionals that group the
 * same amendment cannot be selected together (only one can replace it, and
 * validating it closes the other): while one is selected, the other's
 * checkbox is disabled with the reason.
 *
 * It runs the requests itself and tells the inbox what changed, so the
 * inbox patches its queue right away and refetches in the background.
 */
const props = withDefaults(
  defineProps<{
    group: ReviewDocumentGroup;
    /** "/api/assemblies/<id>" */
    apiBase: string;
    assemblyId: string;
    /** Localized path of the document page. */
    documentPath: string;
  }>(),
  {},
);

const emit = defineEmits<{
  /** The server returned these amendments after an action. */
  updated: [amendments: AmendmentDto[]];
  /** These amendments left the queue (sent back for correction). */
  removed: [ids: string[]];
  /** Someone changed them meanwhile: refetch the queue. */
  conflict: [];
  /** A short sentence for the inbox's live region. */
  announce: [message: string];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();

const headingId = useId();

// The published text, frozen: no need to follow live events.
const { document: fullDocument, pending: documentPending } = useDocument(
  () => props.assemblyId,
  () => props.group.document.id,
  { live: false },
);
const base = computed(() => fullDocument.value?.baseVersion?.blocks ?? null);

// The amendments transactionals group, for their codes. Without a
// transactional the url is null and nothing is fetched.
const hasTransactional = computed(() =>
  [...props.group.toValidate, ...props.group.awaitingAuthors].some(
    (amendment) => amendment.kind === "transactional",
  ),
);
const documentAmendments = useDocumentAmendments({
  assembly: () => props.assemblyId,
  document: () =>
    hasTransactional.value ? props.group.document.id : undefined,
  assemblyId: () => props.assemblyId,
  documentId: () => props.group.document.id,
});

/** Codes of what a transactional groups; null until they are loaded. */
function sourceLabelsOf(amendment: AmendmentDto): string[] | null {
  if (amendment.kind !== "transactional") return null;
  if (!documentAmendments.data.value) return null;
  const known = documentAmendments.byId.value;
  return amendment.sourceIds
    .filter((id) => known.has(id))
    .map((id) => documentAmendments.shortLabelOf(id));
}

const documentUrl = computed(
  () =>
    `${props.apiBase}/documents/${encodeURIComponent(props.group.document.id)}`,
);

function labelOf(amendment: AmendmentDto): string {
  return amendmentDisplayLabel(amendment) ?? t("review.amendments.noCode");
}

// Selection ------------------------------------------------------------------

const selected = ref<Set<string>>(new Set());

const selectableIds = computed(() => selectableReviewIds(props.group));

/**
 * Selecting makes sense only when more than one amendment can be acted on
 * at once (two transactionals over the same amendment cannot).
 */
const multiSelect = computed(() => canSelectSeveral(props.group));

// Drop ids that left the group (validated elsewhere, published...), and the
// whole selection once nothing can be acted on together: no checkboxes.
watch([selectableIds, multiSelect], ([ids, several]) => {
  if (!several) {
    if (selected.value.size > 0) selected.value = new Set();
    return;
  }
  const allowed = new Set(ids);
  const kept = [...selected.value].filter((id) => allowed.has(id));
  if (kept.length !== selected.value.size) selected.value = new Set(kept);
});

/** Transactionals a selected one keeps out, with the one that does. */
const blocked = computed(() =>
  blockedBySelection(props.group.toValidate, selected.value),
);

/** Code of the selected transactional that keeps this one out, if any. */
function blockedByLabel(id: string): string | null {
  const blockerId = blocked.value.get(id);
  if (!blockerId) return null;
  const blocker = props.group.toValidate.find(
    (amendment) => amendment.id === blockerId,
  );
  return blocker ? labelOf(blocker) : null;
}

const selection = computed(() =>
  splitReviewSelection(props.group, selected.value),
);
const selectedCount = computed(
  () => selection.value.validate.length + selection.value.publish.length,
);

/** Checked once nothing else fits (no two transactionals over one amendment). */
const allSelected = computed<boolean | "indeterminate">(() => {
  if (selectedCount.value === 0) return false;
  return isSelectionFull(props.group, selected.value) ? true : "indeterminate";
});

/** Selects everything that still fits, keeping what is already selected. */
function toggleAll(value: boolean | "indeterminate") {
  selected.value =
    value === true
      ? new Set(selectAllReviewIds(props.group, selected.value))
      : new Set();
}

/** Read out when the selection changes; empty while nothing is selected. */
const selectedMessage = computed(() =>
  selectedCount.value > 0
    ? t(
        "review.amendments.selected",
        { count: selectedCount.value },
        selectedCount.value,
      )
    : "",
);

function isSelected(id: string): boolean {
  return selected.value.has(id);
}

function setSelected(id: string, value: boolean) {
  if (value && blocked.value.has(id)) return;
  const next = new Set(selected.value);
  if (value) next.add(id);
  else next.delete(id);
  selected.value = next;
}

function unselect(ids: string[]) {
  const next = new Set(selected.value);
  for (const id of ids) next.delete(id);
  selected.value = next;
}

// Actions ----------------------------------------------------------------------

/** What is running: one amendment's action, or a bulk one ("bulk:<action>"). */
const busy = ref<{ id: string; action: ReviewAmendmentAction } | null>(null);
const BULK = "bulk";

function busyFor(id: string): ReviewAmendmentAction | null {
  return busy.value?.id === id ? busy.value.action : null;
}

function notify(title: string, description?: string) {
  emit("announce", description ? `${title}. ${description}` : title);
  toast.add({
    title,
    description,
    color: "success",
    icon: "i-lucide-check",
  });
}

function lateHint(ids: string[], result: AmendmentDto[]): string | undefined {
  const wanted = new Set(ids);
  const late = result.some(
    (amendment) =>
      wanted.has(amendment.id) &&
      amendment.late &&
      amendment.admission === "pending",
  );
  return late ? t("review.amendments.lateHint") : undefined;
}

function doneMessage(
  action: "validate_publish" | "validate_only" | "publish",
  ids: string[],
  result: AmendmentDto[],
): string {
  const key = `review.amendments.done.${action}`;
  if (ids.length === 1) {
    const amendment = result.find((candidate) => candidate.id === ids[0]);
    const label = amendment ? labelOf(amendment) : "";
    return t(`${key}.one`, { label });
  }
  return t(`${key}.many`, { count: ids.length });
}

async function runValidate(ids: string[], publish: boolean, owner: string) {
  if (ids.length === 0 || busy.value) return;
  const action = publish ? "validate_publish" : "validate_only";
  busy.value = { id: owner, action };
  try {
    const body: ValidateAmendmentsBody = { amendmentIds: ids, publish };
    const result = await api.send<DocumentAmendmentsDto>(
      `${documentUrl.value}/amendments/validate`,
      { method: "POST", body },
    );
    unselect(ids);
    documentAmendments.replace(result);
    emit("updated", result.amendments);
    notify(
      doneMessage(action, ids, result.amendments),
      lateHint(ids, result.amendments),
    );
  } catch (error) {
    api.notifyError(error, "review.amendments.actionError");
    if (api.isConflict(error)) emit("conflict");
  } finally {
    busy.value = null;
  }
}

async function runPublish(ids: string[], owner: string) {
  if (ids.length === 0 || busy.value) return;
  busy.value = { id: owner, action: "publish" };
  try {
    const body: PublishAmendmentsBody = { amendmentIds: ids };
    const result = await api.send<DocumentAmendmentsDto>(
      `${documentUrl.value}/amendments/publish`,
      { method: "POST", body },
    );
    unselect(ids);
    documentAmendments.replace(result);
    emit("updated", result.amendments);
    notify(doneMessage("publish", ids, result.amendments));
  } catch (error) {
    api.notifyError(error, "review.amendments.actionError");
    if (api.isConflict(error)) emit("conflict");
  } finally {
    busy.value = null;
  }
}

// Correction -------------------------------------------------------------------

const correctionTarget = ref<AmendmentDto | null>(null);
const correctionOpen = computed({
  get: () => correctionTarget.value !== null,
  set: (open: boolean) => {
    if (!open && busy.value?.action !== "correction") {
      correctionTarget.value = null;
    }
  },
});

async function sendCorrection(note: string) {
  const amendment = correctionTarget.value;
  if (!amendment || busy.value) return;
  busy.value = { id: amendment.id, action: "correction" };
  try {
    const body: CorrectionBody = { note, updatedAt: amendment.updatedAt };
    await api.send<AmendmentDto>(
      `${documentUrl.value}/amendments/${encodeURIComponent(amendment.id)}/correction`,
      { method: "POST", body },
    );
    busy.value = null;
    correctionTarget.value = null;
    unselect([amendment.id]);
    emit("removed", [amendment.id]);
    notify(
      t("review.amendments.done.correction", { label: labelOf(amendment) }),
      t("review.amendments.correctionHint"),
    );
  } catch (error) {
    busy.value = null;
    api.notifyError(error, "review.amendments.actionError");
    if (api.isConflict(error)) {
      correctionTarget.value = null;
      emit("conflict");
    }
  }
}

// Kind -------------------------------------------------------------------------

const { reclassify } = useReclassifyAmendment();
const documentVoted = computed(() => Boolean(fullDocument.value?.finalVote));

async function runReclassify(amendment: AmendmentDto) {
  if (busy.value) return;
  busy.value = { id: amendment.id, action: "reclassify" };
  try {
    const { updated, conflict } = await reclassify(
      amendment,
      `${documentUrl.value}/amendments/${encodeURIComponent(amendment.id)}`,
    );
    if (updated) emit("updated", [updated]);
    else if (conflict) emit("conflict");
  } finally {
    busy.value = null;
  }
}

function onAction(amendment: AmendmentDto, action: ReviewAmendmentAction) {
  switch (action) {
    case "reclassify":
      void runReclassify(amendment);
      break;
    case "validate_publish":
      void runValidate([amendment.id], true, amendment.id);
      break;
    case "validate_only":
      // A transactional replaces public amendments: never kept private.
      if (amendment.kind !== "transactional") {
        void runValidate([amendment.id], false, amendment.id);
      }
      break;
    case "publish":
      void runPublish([amendment.id], amendment.id);
      break;
    case "correction":
      correctionTarget.value = amendment;
      break;
  }
}

/**
 * Secondary bulk action, under "Más" as on each card. It leaves the
 * selected transactionals out: they are always published when validated.
 */
const bulkMoreItems = computed<DropdownMenuItem[]>(() => [
  {
    label: t("review.amendments.bulkValidateOnly", {
      count: selection.value.validateOnly.length,
    }),
    description:
      selection.value.validateOnly.length < selection.value.validate.length
        ? t("review.amendments.bulkValidateOnlySkipsTransactionals")
        : t("review.amendments.validateOnlyHelp"),
    icon: "i-lucide-check",
    disabled: busy.value !== null,
    onSelect: () => {
      void runValidate(selection.value.validateOnly, false, BULK);
    },
  },
]);

const summary = computed(() =>
  [
    props.group.toValidate.length > 0
      ? t(
          "review.amendments.countToValidate",
          { count: props.group.toValidate.length },
          props.group.toValidate.length,
        )
      : null,
    props.group.awaitingAuthors.length > 0
      ? t(
          "review.amendments.countAwaitingAuthors",
          { count: props.group.awaitingAuthors.length },
          props.group.awaitingAuthors.length,
        )
      : null,
    props.group.toPublish.length > 0
      ? t(
          "review.amendments.countToPublish",
          { count: props.group.toPublish.length },
          props.group.toPublish.length,
        )
      : null,
  ]
    .filter(Boolean)
    .join(" · "),
);
</script>

<template>
  <section class="space-y-3" :aria-labelledby="headingId">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 space-y-0.5">
        <h4 :id="headingId" class="text-highlighted font-semibold">
          <NuxtLink
            :to="props.documentPath"
            class="focus-visible:outline-primary rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {{ group.document.title }}
          </NuxtLink>
          <span
            v-if="group.document.reference"
            class="text-muted text-sm font-normal tabular-nums"
          >
            · {{ group.document.reference }}</span
          >
        </h4>
        <p class="text-muted text-sm">{{ summary }}</p>
      </div>
      <UCheckbox
        v-if="multiSelect"
        :model-value="allSelected"
        :label="t('review.amendments.selectAll')"
        @update:model-value="toggleAll"
      />
    </div>

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ selectedMessage }}
    </p>

    <!-- Bulk actions, only while something is selected. -->
    <div
      v-if="selectedCount > 0"
      class="border-primary/40 bg-primary/5 sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border p-2"
      role="group"
      :aria-label="
        t('review.amendments.bulkLabel', { title: group.document.title })
      "
    >
      <span class="text-highlighted px-1 text-sm font-medium">
        {{ selectedMessage }}
      </span>
      <UButton
        v-if="selection.validate.length > 0"
        size="sm"
        icon="i-lucide-check-check"
        :label="
          t('review.amendments.bulkValidatePublish', {
            count: selection.validate.length,
          })
        "
        :loading="busyFor(BULK) === 'validate_publish'"
        :disabled="busy !== null && busyFor(BULK) !== 'validate_publish'"
        @click="runValidate(selection.validate, true, BULK)"
      />
      <UButton
        v-if="selection.publish.length > 0"
        size="sm"
        :color="selection.validate.length > 0 ? 'neutral' : 'primary'"
        :variant="selection.validate.length > 0 ? 'outline' : 'solid'"
        icon="i-lucide-megaphone"
        :label="
          t('review.amendments.bulkPublish', {
            count: selection.publish.length,
          })
        "
        :loading="busyFor(BULK) === 'publish'"
        :disabled="busy !== null && busyFor(BULK) !== 'publish'"
        @click="runPublish(selection.publish, BULK)"
      />
      <UDropdownMenu
        v-if="selection.validateOnly.length > 0"
        :items="bulkMoreItems"
        :content="{ align: 'start' }"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-ellipsis"
          :label="t('review.more')"
          :loading="busyFor(BULK) === 'validate_only'"
          :disabled="busy !== null && busyFor(BULK) !== 'validate_only'"
        />
      </UDropdownMenu>
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        :label="t('review.amendments.clearSelection')"
        :disabled="busy !== null"
        @click="toggleAll(false)"
      />
    </div>

    <ul v-if="group.toValidate.length > 0" class="space-y-3">
      <li v-for="amendment in group.toValidate" :key="amendment.id">
        <ReviewAmendmentCard
          :amendment="amendment"
          :base="base"
          :base-loading="documentPending"
          :document-voted="documentVoted"
          :source-labels="sourceLabelsOf(amendment)"
          :busy="busyFor(amendment.id)"
          :disabled="busy !== null"
          :multi-select="multiSelect"
          :selected="isSelected(amendment.id)"
          :select-blocked-by="blockedByLabel(amendment.id)"
          @update:selected="
            (value: boolean) => setSelected(amendment.id, value)
          "
          @action="(action) => onAction(amendment, action)"
        />
      </li>
    </ul>

    <div v-if="group.awaitingAuthors.length > 0" class="space-y-2">
      <div>
        <h5 class="text-highlighted text-sm font-semibold">
          {{ t("review.amendments.awaitingAuthorsTitle") }}
        </h5>
        <p class="text-muted text-sm">
          {{ t("review.amendments.awaitingAuthorsHelp") }}
        </p>
      </div>
      <ul class="space-y-3">
        <li v-for="amendment in group.awaitingAuthors" :key="amendment.id">
          <ReviewAmendmentCard
            :amendment="amendment"
            :base="base"
            :base-loading="documentPending"
            :document-voted="documentVoted"
            :source-labels="sourceLabelsOf(amendment)"
            :heading-level="6"
          />
        </li>
      </ul>
    </div>

    <!-- Its own section of the inbox says what these are. -->
    <ul v-if="group.toPublish.length > 0" class="space-y-3">
      <li v-for="amendment in group.toPublish" :key="amendment.id">
        <ReviewAmendmentCard
          :amendment="amendment"
          :base="base"
          :base-loading="documentPending"
          :document-voted="documentVoted"
          :busy="busyFor(amendment.id)"
          :disabled="busy !== null"
          :multi-select="multiSelect"
          :selected="isSelected(amendment.id)"
          @update:selected="
            (value: boolean) => setSelected(amendment.id, value)
          "
          @action="(action) => onAction(amendment, action)"
        />
      </li>
    </ul>

    <ReviewCorrectionModal
      v-model:open="correctionOpen"
      kind="amendment"
      :subject="correctionTarget ? labelOf(correctionTarget) : ''"
      :busy="busy?.action === 'correction'"
      @confirm="sendCorrection"
    />
  </section>
</template>
