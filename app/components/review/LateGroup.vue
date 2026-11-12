<script setup lang="ts">
import type {
  AdmissionBody,
  AmendmentAdmissionDto,
  AmendmentDto,
  DocumentAmendmentsDto,
  PublishAmendmentsBody,
} from "~~/shared/types/api";
import type { AssemblySettings } from "~~/shared/constants/domain";
import {
  canRecordAdmission,
  type AdmissionChoice,
  type ReviewAmendmentAction,
  type ReviewDocumentGroup,
} from "./-queue";

/**
 * The late amendments of one document that the Secretaría already validated
 * and that wait for the assembly to decide whether to treat them. Whoever
 * keeps the record writes down that decision here, one by one or for
 * several at once (POST .../amendments/admission, per document): treating
 * them publishes them and lets them be debated; not treating them leaves
 * them out. One still private can be published first, so delegates read it
 * before deciding.
 *
 * It runs the requests itself and tells the inbox what changed, as
 * AmendmentGroup does.
 */
const props = defineProps<{
  group: Pick<ReviewDocumentGroup, "document" | "late">;
  /** "/api/assemblies/<id>" */
  apiBase: string;
  assemblyId: string;
  /** Localized path of the document page. */
  documentPath: string;
  settings: Pick<AssemblySettings, "denominator" | "tieRule">;
}>();

const emit = defineEmits<{
  /** The server returned these amendments after an action. */
  updated: [amendments: AmendmentDto[]];
  /** These amendments left the list (the assembly decided). */
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

const { document: fullDocument, pending: documentPending } = useDocument(
  () => props.assemblyId,
  () => props.group.document.id,
  { live: false },
);
const base = computed(() => fullDocument.value?.baseVersion?.blocks ?? null);

const documentUrl = computed(
  () =>
    `${props.apiBase}/documents/${encodeURIComponent(props.group.document.id)}`,
);

function labelOf(amendment: AmendmentDto): string {
  return amendmentDisplayLabel(amendment) ?? t("review.amendments.noCode");
}

// Selection ------------------------------------------------------------------

const selected = ref<Set<string>>(new Set());

const selectableIds = computed(() =>
  props.group.late
    .filter((amendment) => canRecordAdmission(amendment))
    .map((amendment) => amendment.id),
);

const multiSelect = computed(() => selectableIds.value.length > 1);

watch(selectableIds, (ids) => {
  if (ids.length <= 1) {
    if (selected.value.size > 0) selected.value = new Set();
    return;
  }
  const allowed = new Set(ids);
  const kept = [...selected.value].filter((id) => allowed.has(id));
  if (kept.length !== selected.value.size) selected.value = new Set(kept);
});

const chosen = computed(() =>
  selectableIds.value.filter((id) => selected.value.has(id)),
);

const allSelected = computed<boolean | "indeterminate">(() => {
  if (chosen.value.length === 0) return false;
  return chosen.value.length === selectableIds.value.length
    ? true
    : "indeterminate";
});

function toggleAll(value: boolean | "indeterminate") {
  selected.value = value === true ? new Set(selectableIds.value) : new Set();
}

function setSelected(id: string, value: boolean) {
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

const selectedMessage = computed(() =>
  chosen.value.length > 0
    ? t(
        "review.amendments.selected",
        { count: chosen.value.length },
        chosen.value.length,
      )
    : "",
);

// Actions ----------------------------------------------------------------------

const BULK = "bulk";
const busy = ref<{ id: string; action: ReviewAmendmentAction } | null>(null);

function busyFor(id: string): ReviewAmendmentAction | null {
  return busy.value?.id === id ? busy.value.action : null;
}

function notify(title: string, description?: string) {
  emit("announce", description ? `${title}. ${description}` : title);
  toast.add({ title, description, color: "success", icon: "i-lucide-check" });
}

/** The amendments the decision dialog is open for. */
const target = ref<{
  ids: string[];
  owner: string;
  decision: AdmissionBody["decision"];
} | null>(null);

const dialogOpen = computed({
  get: () => target.value !== null,
  set: (open: boolean) => {
    if (!open && !busy.value) target.value = null;
  },
});

const targetAmendments = computed(() => {
  const ids = new Set(target.value?.ids ?? []);
  return props.group.late.filter((amendment) => ids.has(amendment.id));
});

// Several Mesa members work at once: another one may record the decision
// while this dialog is open, and the live refetch drops those amendments.
// Narrow the dialog to the ones still waiting, or close it with a calm note
// when none is left, instead of saving into a 409. A save in flight is left
// alone: it clears `target` before reporting what it removed.
watch(targetAmendments, (list) => {
  const current = target.value;
  if (!current || busy.value) return;
  if (list.length === 0) {
    target.value = null;
    const message = t("review.late.alreadyRecorded", current.ids.length);
    emit("announce", message);
    toast.add({ title: message, color: "neutral", icon: "i-lucide-info" });
    return;
  }
  if (list.length < current.ids.length) {
    target.value = { ...current, ids: list.map((amendment) => amendment.id) };
  }
});

/**
 * What the dialog is about, and whether they are all public already (then
 * it does not say treating them publishes them). It keeps the last
 * amendments it named while it closes, so its text never reads "0 enmiendas".
 */
const dialogView = ref({ subject: "", count: 1, allPublic: false });
watch(
  targetAmendments,
  (list) => {
    if (list.length === 0) return;
    dialogView.value = {
      subject:
        list.length === 1
          ? labelOf(list[0]!)
          : t(
              "review.late.amendmentCount",
              { count: list.length },
              list.length,
            ),
      count: list.length,
      allPublic: list.every((amendment) => amendment.publishedAt !== null),
    };
  },
  { immediate: true },
);

function openDecision(
  ids: string[],
  owner: string,
  decision: AdmissionBody["decision"],
) {
  if (ids.length === 0 || busy.value) return;
  target.value = { ids, owner, decision };
}

async function recordDecision(choice: AdmissionChoice) {
  const current = target.value;
  if (!current || busy.value) return;
  const labels = targetAmendments.value.map(labelOf);
  busy.value = {
    id: current.owner,
    action: current.decision === "admitted" ? "admit" : "inadmit",
  };
  try {
    const body: AdmissionBody = { amendmentIds: current.ids, ...choice };
    const result = await api.send<AmendmentAdmissionDto>(
      `${documentUrl.value}/amendments/admission`,
      { method: "POST", body },
    );
    busy.value = null;
    target.value = null;
    unselect(current.ids);
    emit("removed", current.ids);
    // A failed vote leaves them out even if the dialog opened to treat them.
    const treated = result.admission === "admitted";
    const count = result.amendmentIds.length || current.ids.length;
    const key = treated ? "treat" : "notTreat";
    notify(
      count === 1
        ? t(`review.late.done.${key}.one`, { label: labels[0] ?? "" })
        : t(`review.late.done.${key}.many`, { count }),
      t(`review.late.done.${key}Hint`, count),
    );
  } catch (error) {
    busy.value = null;
    api.notifyError(error, "review.late.decisionError");
    if (api.isConflict(error)) {
      target.value = null;
      emit("conflict");
    }
  }
}

async function publish(amendment: AmendmentDto) {
  if (busy.value) return;
  busy.value = { id: amendment.id, action: "publish" };
  try {
    const body: PublishAmendmentsBody = { amendmentIds: [amendment.id] };
    const result = await api.send<DocumentAmendmentsDto>(
      `${documentUrl.value}/amendments/publish`,
      { method: "POST", body },
    );
    emit("updated", result.amendments);
    notify(
      t("review.amendments.done.publish.one", { label: labelOf(amendment) }),
    );
  } catch (error) {
    api.notifyError(error, "review.amendments.actionError");
    if (api.isConflict(error)) emit("conflict");
  } finally {
    busy.value = null;
  }
}

function onAction(amendment: AmendmentDto, action: ReviewAmendmentAction) {
  switch (action) {
    case "admit":
      openDecision([amendment.id], amendment.id, "admitted");
      break;
    case "inadmit":
      openDecision([amendment.id], amendment.id, "inadmissible");
      break;
    case "publish":
      void publish(amendment);
      break;
  }
}

const summary = computed(() =>
  t(
    "review.late.countWaiting",
    { count: props.group.late.length },
    props.group.late.length,
  ),
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

    <div
      v-if="chosen.length > 0"
      class="border-primary/40 bg-primary/5 sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border p-2"
      role="group"
      :aria-label="t('review.late.bulkLabel', { title: group.document.title })"
    >
      <span class="text-highlighted px-1 text-sm font-medium">
        {{ selectedMessage }}
      </span>
      <UButton
        size="sm"
        icon="i-lucide-check"
        :label="t('review.late.bulkTreat', { count: chosen.length })"
        :loading="busyFor(BULK) === 'admit'"
        :disabled="busy !== null && busyFor(BULK) !== 'admit'"
        @click="openDecision(chosen, BULK, 'admitted')"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-x"
        :label="t('review.late.bulkNotTreat', { count: chosen.length })"
        :loading="busyFor(BULK) === 'inadmit'"
        :disabled="busy !== null && busyFor(BULK) !== 'inadmit'"
        @click="openDecision(chosen, BULK, 'inadmissible')"
      />
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

    <ul class="space-y-3">
      <li v-for="amendment in group.late" :key="amendment.id">
        <ReviewAmendmentCard
          :amendment="amendment"
          :base="base"
          :base-loading="documentPending"
          :busy="busyFor(amendment.id)"
          :disabled="busy !== null"
          :multi-select="multiSelect"
          :selected="selected.has(amendment.id)"
          @update:selected="
            (value: boolean) => setSelected(amendment.id, value)
          "
          @action="(action) => onAction(amendment, action)"
        />
      </li>
    </ul>

    <ReviewAdmissionModal
      v-model:open="dialogOpen"
      :subject="dialogView.subject"
      :count="dialogView.count"
      :all-public="dialogView.allPublic"
      :document-title="group.document.title"
      :initial-decision="target?.decision ?? 'admitted'"
      :settings="props.settings"
      :assembly-id="props.assemblyId"
      :busy="
        busy !== null && (busy.action === 'admit' || busy.action === 'inadmit')
      "
      @confirm="recordDecision"
    />
  </section>
</template>
