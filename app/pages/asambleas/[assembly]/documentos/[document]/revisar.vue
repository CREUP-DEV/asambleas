<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { AcceptanceDecision } from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";
import { transactionalSourceEligible } from "~/composables/amendment/transactional";
import {
  acceptanceTarget,
  commentUnsaved,
  fallbackStep,
  firstPendingId,
  initialStep,
  positionAnswer,
  positionCounts,
  proponentReviewItems,
  proponentReviewProgress,
  recordedPositionCounts,
  reviewSequence,
  stepAfter,
  stepBefore,
  stepCounter,
  stepIndex,
  transactionalAnswerCounts,
  type ProponentAnswer,
  type ProponentReviewItem,
} from "~/components/proponent-review/-review";

/**
 * The presenter's review mode (inside the assembly hub), for the member
 * that presents the document and for the Mesa answering for it: one
 * amendment at a time, with the change in large type, its justification and
 * three choices (Aceptar, Rechazar, Transaccionar) with an optional comment.
 * Pressing a choice saves it and moves on. Transactionals waiting for the
 * presenter's approval come first, with "Aprobar" and "Rechazar".
 *
 * A progress line counts the answered amendments; "Solo las que faltan"
 * hides the answered ones (the one on screen stays until the user moves
 * on). The full list sits beside the step on wide screens and in a
 * slideover on phones. The end shows a summary. Shortcuts: A, R, T answer,
 * J and K move; they never fire while typing.
 *
 * A comment is saved with the answer. Moving on with a comment not saved
 * says so (and offers to go back), the list marks it, and leaving the page
 * asks first. After "Transaccionar", a link opens the transactional
 * composer of the workspace on that amendment (`?transaccional=<id>`).
 *
 * The presenter's answer to a transactional is found by member
 * (`document.proponent`), as the server does: when the presenter also
 * wrote one of the amendments it groups, its row has the role "author".
 *
 * Everything stays fresh through the hub's live stream (useDocument and
 * useDocumentAmendments subscribe to it). `?enmienda=<id>` opens on that
 * amendment.
 */

type Decision = Exclude<AcceptanceDecision, "pending">;

interface Focusable {
  focus: () => void;
}

const { t } = useI18n();
const route = useRoute();
const api = useApi();
const toast = useToast();
const { member } = useMe();
const workspace = useDocumentWorkspace();
const {
  assembly,
  document,
  base,
  amendments: list,
  amendmentsUrl,
  documentPath,
  pending,
  errorStatusCode,
  refreshAll,
} = workspace;

useHead({
  title: () =>
    document.value
      ? t("proponentReview.pageTitle", { title: document.value.title })
      : t("proponentReview.title"),
});

const actorMemberId = computed(() => member.value?.id ?? null);
/** The document's presenter: whose answers these are. */
const proponentMemberId = computed(() => document.value?.proponent?.id ?? null);

// Access ------------------------------------------------------------------------

const isPublished = computed(
  () => Boolean(document.value?.baseVersion) && base.value.length > 0,
);
/** Voted: answers can no longer change (the server refuses them). */
const readOnly = computed(() => Boolean(document.value?.finalVote));
/** Its presenter's member, or the Mesa: whoever answers its amendments. */
const mayReview = computed(() => {
  const doc = document.value;
  if (!doc) return false;
  if (doc.can.moderate || doc.can.position) return true;
  return (
    actorMemberId.value !== null && doc.proponent?.id === actorMemberId.value
  );
});

/** The Mesa answers for the presenter's member when it is not that member. */
const onBehalfOf = computed(() => {
  const proponent = document.value?.proponent ?? null;
  if (!proponent || proponent.id === actorMemberId.value) return null;
  return proponent;
});

/** Who reads the presenter's answers, from the assembly's policy. */
const visibilityNote = computed(() =>
  t(
    `proponentReview.visibility.${assembly.value?.settings.positionVisibility ?? "session"}`,
  ),
);

/**
 * The actor may propose a transactional from the workspace: the same rule
 * as its "Proponer una transaccional" (canTransact in the document page).
 */
const canProposeTransactional = computed(() => {
  const doc = document.value;
  if (
    !doc ||
    doc.format !== "structured" ||
    !isPublished.value ||
    doc.finalVote ||
    assembly.value?.status === "closed"
  ) {
    return false;
  }
  return doc.can.moderate || (doc.can.amend && Boolean(member.value));
});

/**
 * Where "Proponer la transaccional" goes for an amendment: the workspace's
 * composer on it. Null when it cannot be combined (the composer would drop
 * it) or the actor cannot propose one.
 */
function transactLink(amendment: AmendmentDto): RouteLocationRaw | null {
  if (!canProposeTransactional.value) return null;
  if (!transactionalSourceEligible(amendment)) return null;
  return { path: documentPath(), query: { transaccional: amendment.id } };
}

// Steps -------------------------------------------------------------------------

const items = computed<ProponentReviewItem[]>(() =>
  readOnly.value
    ? []
    : proponentReviewItems(
        list.amendments.value,
        actorMemberId.value,
        proponentMemberId.value,
      ),
);
const progress = computed(() => proponentReviewProgress(items.value));

/** The review screen is on (not a guard, loading or empty state). */
const reviewing = computed(
  () =>
    Boolean(document.value?.can.position) &&
    isPublished.value &&
    !readOnly.value &&
    items.value.length > 0,
);

const onlyPending = ref(true);
const showSummary = ref(false);
/** The step the user moved to; null until they move. */
const chosenId = ref<string | null>(null);
const linkedId =
  typeof route.query.enmienda === "string" ? route.query.enmienda : null;
/**
 * The step on screen: the one the user moved to or, until they move, the
 * linked one or the first still waiting. Derived rather than set by a
 * watcher, so the server render and the hydrated page agree.
 */
const currentId = computed(
  () =>
    chosenId.value ??
    (showSummary.value ? null : initialStep(items.value, linkedId)),
);
const listOpen = ref(false);
/** The request running: an answer, or a comment saved on its own. */
const busy = ref<{
  id: string;
  value: ProponentAnswer | Decision;
  commentOnly?: boolean;
} | null>(null);

const sequence = computed(() =>
  reviewSequence(items.value, {
    onlyPending: onlyPending.value,
    pinnedId: currentId.value,
  }),
);
const current = computed(
  () => sequence.value.find((item) => item.id === currentId.value) ?? null,
);
const currentIndex = computed(() => stepIndex(sequence.value, currentId.value));
const hasPrevious = computed(() => currentIndex.value > 0);
/**
 * "Enmienda 5 de 12" or "Transaccional 1 de 2": where the step sits among
 * those of its kind in the whole review. The total is the progress line's,
 * and hiding the answered ones does not turn it into a countdown.
 */
const counterLabel = computed(() => {
  const counter = stepCounter(items.value, currentId.value);
  if (!counter) return "";
  return t(
    counter.kind === "transactional"
      ? "proponentReview.nav.transactional"
      : "proponentReview.nav.amendment",
    { current: counter.current, total: counter.total },
  );
});
const hasNext = computed(
  () => stepAfter(sequence.value, currentId.value) !== null,
);

function labelOf(item: Pick<ProponentReviewItem, "amendment">): string {
  return amendmentDisplayLabel(item.amendment) ?? t("proponentReview.noCode");
}

/**
 * Where the step on screen sat, to land on its neighbour when it leaves (an
 * amendment decided or withdrawn meanwhile, a transactional answered by the
 * Mesa). Steps this visit answered leave on purpose: no notice for those.
 */
let lastIndex = 0;
const handled = new Set<string>();

watch(sequence, (steps, previous) => {
  const id = chosenId.value;
  // Not moved yet: the first step still waiting follows the list by itself.
  if (id === null || !list.data.value) return;
  const index = stepIndex(steps, id);
  if (index >= 0) {
    lastIndex = index;
    return;
  }
  if (!handled.has(id) && !showSummary.value) {
    const gone = previous?.find((item) => item.id === id);
    toast.add({
      id: `proponent-review-gone-${id}`,
      title: t("proponentReview.gone", {
        label: gone ? labelOf(gone) : "",
      }),
      color: "info",
      icon: "i-lucide-info",
    });
  }
  chosenId.value = fallbackStep(steps, lastIndex);
});

// Once on the client, the step on screen stays put: a live refresh never
// swaps it for another while the user reads it or types a comment.
onMounted(() => {
  watch(
    currentId,
    (id) => {
      if (chosenId.value === null && id !== null) chosenId.value = id;
    },
    { immediate: true },
  );
});

const step = useTemplateRef<Focusable>("step");
const summary = useTemplateRef<Focusable>("summary");

function focusCurrent(): void {
  (showSummary.value ? summary.value : step.value)?.focus();
}

/**
 * Picked from the list in the slideover: focus moves once it has closed,
 * or the slideover would hand it back to the button that opened it.
 */
let focusAfterList = false;
function onListClosed(): void {
  if (!focusAfterList) return;
  focusAfterList = false;
  focusCurrent();
}

/**
 * Shows a step, or the summary for null, and with `focus` moves focus to
 * its heading so screen readers start from the new amendment. Leaving a
 * step whose comment is not saved says so (the draft stays for this visit).
 */
function goTo(id: string | null, options: { focus?: boolean } = {}): void {
  warnIfUnsaved(id);
  if (id === null) {
    showSummary.value = true;
  } else {
    chosenId.value = id;
    showSummary.value = false;
  }
  if (listOpen.value) {
    listOpen.value = false;
    focusAfterList = Boolean(options.focus);
    return;
  }
  if (options.focus) void nextTick(focusCurrent);
}

function goNext(): void {
  if (busy.value || showSummary.value || !current.value) return;
  goTo(stepAfter(sequence.value, currentId.value), { focus: true });
}

function goPrevious(): void {
  if (busy.value) return;
  if (showSummary.value || !current.value) {
    const last = sequence.value.at(-1);
    if (last) goTo(last.id, { focus: true });
    return;
  }
  const previous = stepBefore(sequence.value, currentId.value);
  if (previous) goTo(previous, { focus: true });
}

function answerLeft(): void {
  onlyPending.value = true;
  goTo(firstPendingId(items.value), { focus: true });
}

function reviewAll(): void {
  onlyPending.value = false;
  goTo(items.value[0]?.id ?? null, { focus: true });
}

// Answers -------------------------------------------------------------------------

/** Comments being typed, per amendment; the saved one shows otherwise. */
const commentDrafts = reactive(new Map<string, string>());

/** Steps whose comment was typed and not saved. */
const unsavedIds = computed(
  () =>
    new Set(
      items.value
        .filter(
          (item) =>
            item.kind === "position" &&
            commentUnsaved(
              commentDrafts.get(item.id),
              item.amendment.position?.comment,
            ),
        )
        .map((item) => item.id),
    ),
);

/**
 * Moving from the step on screen to `toId` with its comment not saved: a
 * calm notice, with a way back. The draft itself stays for this visit.
 */
function warnIfUnsaved(toId: string | null): void {
  const item = current.value;
  if (showSummary.value || !item || item.id === toId) return;
  if (!unsavedIds.value.has(item.id)) return;
  toast.add({
    id: `proponent-review-unsaved-${item.id}`,
    title: t("proponentReview.unsaved.title", { label: labelOf(item) }),
    description: item.answered
      ? t("proponentReview.unsaved.answered")
      : t("proponentReview.unsaved.pending"),
    color: "warning",
    icon: "i-lucide-message-square-warning",
    actions: [
      {
        label: t("proponentReview.unsaved.back"),
        color: "neutral",
        variant: "outline",
        onClick: () => {
          // Decided meanwhile: nothing to go back to.
          if (items.value.some((step) => step.id === item.id)) {
            goTo(item.id, { focus: true });
          }
        },
      },
    ],
  });
}

// Leaving the page with comments not saved asks first, as the composers do.
onBeforeRouteLeave(() => {
  if (unsavedIds.value.size === 0) return true;
  return window.confirm(t("proponentReview.unsaved.leaveConfirm"));
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (unsavedIds.value.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
}

onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
});

const comment = computed({
  get: () => {
    const item = current.value;
    if (!item) return "";
    return commentDrafts.get(item.id) ?? item.amendment.position?.comment ?? "";
  },
  set: (value: string) => {
    const item = current.value;
    if (!item) return;
    chosenId.value = item.id;
    commentDrafts.set(item.id, value);
  },
});

function amendmentUrl(id: string): string {
  return `${amendmentsUrl.value}/${encodeURIComponent(id)}`;
}

/**
 * Saves the answer with the comment and moves on; with `commentOnly` (the
 * comment changed on an answered amendment) it keeps the answer and stays.
 */
async function answerPosition(
  answer: ProponentAnswer,
  options: { commentOnly?: boolean } = {},
): Promise<void> {
  const item = current.value;
  if (!item || item.kind !== "position" || busy.value) return;
  chosenId.value = item.id;
  busy.value = { id: item.id, value: answer, commentOnly: options.commentOnly };
  try {
    const updated = await api.send<AmendmentDto>(
      `${amendmentUrl(item.id)}/position`,
      {
        method: "PUT",
        body: {
          position: answer,
          comment: comment.value.trim() || null,
        },
      },
    );
    list.upsert(updated);
    commentDrafts.delete(item.id);
    // "Transaccionar" moves on at once: the way to write the transactional
    // rides on the notice (and stays on the step for later).
    const transactTo =
      answer === "transact" && !options.commentOnly
        ? transactLink(updated)
        : null;
    toast.add({
      id: "proponent-review-saved",
      title: options.commentOnly
        ? t("proponentReview.commentSaved", { label: labelOf(item) })
        : t(`proponentReview.saved.${answer}`, { label: labelOf(item) }),
      color: "success",
      icon: "i-lucide-check",
      ...(transactTo
        ? {
            duration: 10_000,
            actions: [
              {
                label: t("proponentReview.answer.proposeTransactional"),
                color: "neutral" as const,
                variant: "outline" as const,
                onClick: () => {
                  void navigateTo(transactTo);
                },
              },
            ],
          }
        : {}),
    });
    // The answered step stays pinned until now, so its neighbour is known.
    if (!options.commentOnly && currentId.value === item.id) {
      goTo(stepAfter(sequence.value, item.id), { focus: true });
    }
  } catch (error) {
    api.notifyError(error, "proponentReview.saveFailed");
    if (api.isConflict(error)) void list.refresh();
  } finally {
    busy.value = null;
  }
}

async function answerTransactional(decision: Decision): Promise<void> {
  const item = current.value;
  if (!item || item.kind !== "transactional" || busy.value) return;
  const target = acceptanceTarget(
    item.amendment,
    actorMemberId.value,
    proponentMemberId.value,
  );
  if (!target) return;
  chosenId.value = item.id;
  busy.value = { id: item.id, value: decision };
  try {
    const updated = await api.send<AmendmentDto>(
      `${amendmentUrl(item.id)}/acceptance`,
      {
        body: {
          decision,
          ...(target.memberId ? { memberId: target.memberId } : {}),
        },
      },
    );
    // Answered, it leaves the review: find where to go before it does.
    const next = stepAfter(sequence.value, item.id);
    handled.add(item.id);
    list.upsert(updated);
    toast.add({
      id: "proponent-review-saved",
      title: t(
        decision === "accepted"
          ? "proponentReview.transactional.approved"
          : "proponentReview.transactional.rejected",
        { label: labelOf(item) },
      ),
      color: "success",
      icon: "i-lucide-check",
    });
    if (currentId.value === item.id) goTo(next, { focus: true });
  } catch (error) {
    api.notifyError(error, "amendment.acceptances.failed");
    if (api.isConflict(error)) void list.refresh();
  } finally {
    busy.value = null;
  }
}

const currentTarget = computed(() =>
  current.value?.kind === "transactional"
    ? acceptanceTarget(
        current.value.amendment,
        actorMemberId.value,
        proponentMemberId.value,
      )
    : null,
);
/** "Proponer la transaccional" on the amendment on screen, when it fits. */
const currentTransactTo = computed(() =>
  current.value?.kind === "position"
    ? transactLink(current.value.amendment)
    : null,
);
const currentSources = computed(() =>
  current.value?.kind === "transactional"
    ? current.value.amendment.sourceIds
        .map((id) => list.byId.value.get(id))
        .filter((source): source is AmendmentDto => Boolean(source))
    : [],
);
const busyAnswer = computed(() =>
  busy.value && busy.value.id === currentId.value && !busy.value.commentOnly
    ? busy.value.value
    : null,
);
const commentBusy = computed(
  () => Boolean(busy.value?.commentOnly) && busy.value?.id === currentId.value,
);

/** Answered, and the comment typed is not the one saved. */
const commentChanged = computed(() => {
  const item = current.value;
  if (!item || item.kind !== "position" || !item.answered) return false;
  return unsavedIds.value.has(item.id);
});

function saveComment(): void {
  const item = current.value;
  const answer = item ? positionAnswer(item.amendment) : null;
  if (answer) void answerPosition(answer, { commentOnly: true });
}

// Summary -------------------------------------------------------------------------

const summaryCounts = computed(() =>
  readOnly.value
    ? recordedPositionCounts(list.amendments.value)
    : positionCounts(items.value),
);
/** The presenter's answers to transactionals, from the data (a reload keeps them). */
const summaryTransactionals = computed(() => ({
  ...transactionalAnswerCounts(list.amendments.value, proponentMemberId.value),
  left: progress.value.transactionals,
}));

// Shortcuts -----------------------------------------------------------------------

/**
 * Shortcuts act once per press, only on the review screen, never while a
 * request runs, and not inside a dialog, menu or list box (where letters
 * and keys mean something else). Inputs and textareas are skipped by
 * defineShortcuts itself.
 */
function shortcutsBlocked(event?: KeyboardEvent): boolean {
  if (event?.repeat || !reviewing.value || busy.value || listOpen.value) {
    return true;
  }
  const active = import.meta.client ? globalThis.document.activeElement : null;
  return Boolean(
    active?.closest('[role="dialog"], [role="menu"], [role="listbox"]'),
  );
}

function shortcutAnswer(
  event: KeyboardEvent | undefined,
  answer: ProponentAnswer,
): void {
  if (shortcutsBlocked(event) || showSummary.value) return;
  if (current.value?.kind === "position") {
    void answerPosition(answer);
    return;
  }
  // A, R and T answer amendments: say so instead of doing nothing.
  if (current.value?.kind === "transactional") {
    toast.add({
      id: "proponent-review-shortcut-transactional",
      title: t("proponentReview.shortcuts.notHere"),
      color: "info",
      icon: "i-lucide-keyboard",
    });
  }
}

defineShortcuts({
  a: (event?: KeyboardEvent) => shortcutAnswer(event, "accept"),
  r: (event?: KeyboardEvent) => shortcutAnswer(event, "reject"),
  t: (event?: KeyboardEvent) => shortcutAnswer(event, "transact"),
  j: (event?: KeyboardEvent) => {
    if (!shortcutsBlocked(event)) goNext();
  },
  k: (event?: KeyboardEvent) => {
    if (!shortcutsBlocked(event)) goPrevious();
  },
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- Loading -->
    <div
      v-if="pending"
      class="flex flex-col gap-4"
      aria-busy="true"
      :aria-label="t('workspace.loading')"
    >
      <USkeleton class="h-4 w-32" />
      <USkeleton class="h-8 w-2/3 max-w-xl" />
      <USkeleton class="h-3 w-full max-w-4xl" />
      <USkeleton class="h-80 w-full max-w-4xl" />
    </div>

    <!-- Error -->
    <CommonEmptyState
      v-else-if="!document || !assembly"
      :icon="
        errorStatusCode === 404
          ? 'i-lucide-file-question'
          : 'i-lucide-cloud-off'
      "
      :title="
        errorStatusCode === 404
          ? t('workspace.notFound')
          : t('workspace.loadError')
      "
      :description="
        errorStatusCode === 404
          ? t('workspace.notFoundDescription')
          : t('workspace.loadErrorDescription')
      "
    >
      <template #action>
        <UButton
          v-if="errorStatusCode !== 404"
          icon="i-lucide-refresh-ccw"
          :label="t('workspace.retry')"
          @click="refreshAll"
        />
        <UButton
          :to="workspace.hub.sectionPath('documentos')"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('workspace.backToDocuments')"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <header class="space-y-1">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <UButton
            :to="documentPath()"
            color="neutral"
            variant="link"
            size="sm"
            icon="i-lucide-arrow-left"
            class="px-0"
            :label="t('proponentReview.back')"
          />
          <div v-if="reviewing" class="flex items-center gap-2">
            <ProponentReviewShortcutHelp class="hidden lg:inline-flex" />
            <UButton
              class="lg:hidden"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-list"
              :label="t('proponentReview.list.open')"
              @click="listOpen = true"
            />
          </div>
        </div>
        <h2 class="text-highlighted text-xl font-bold sm:text-2xl">
          {{ t("proponentReview.title") }}
        </h2>
        <p class="text-muted text-sm">
          <span v-if="document.reference" class="tabular-nums">
            {{ document.reference }} ·
          </span>
          {{ document.title }}
        </p>
      </header>

      <!-- Uploaded PDF -->
      <CommonEmptyState
        v-if="document.format === 'file'"
        icon="i-lucide-file-text"
        :title="t('proponentReview.file.title')"
        :description="t('proponentReview.file.description')"
        variant="outline"
      />

      <!-- Not published yet -->
      <CommonEmptyState
        v-else-if="!isPublished"
        icon="i-lucide-file-clock"
        :title="t('proponentReview.unpublished.title')"
        :description="t('proponentReview.unpublished.description')"
        variant="outline"
      />

      <!-- Neither its presenter nor the Mesa -->
      <CommonEmptyState
        v-else-if="!mayReview"
        icon="i-lucide-lock"
        :title="t('proponentReview.noAccess.title')"
        :description="t('proponentReview.noAccess.description')"
        variant="outline"
      >
        <template #action>
          <UButton
            :to="documentPath()"
            icon="i-lucide-arrow-left"
            :label="t('proponentReview.back')"
          />
        </template>
      </CommonEmptyState>

      <!-- Amendments loading -->
      <div
        v-else-if="list.pending.value && !list.data.value"
        class="flex max-w-4xl flex-col gap-4"
        aria-busy="true"
        :aria-label="t('proponentReview.loading')"
      >
        <USkeleton class="h-3 w-full" />
        <USkeleton class="h-80 w-full" />
      </div>

      <UAlert
        v-else-if="list.error.value && !list.data.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        role="alert"
        :title="t('amendment.list.error')"
        :actions="[
          {
            label: t('amendment.actions.retry'),
            icon: 'i-lucide-refresh-ccw',
            color: 'neutral',
            variant: 'outline',
            onClick: () => {
              void list.refresh();
            },
          },
        ]"
      />

      <!-- Voted: what was answered, nothing to change -->
      <ProponentReviewSummary
        v-else-if="readOnly"
        :counts="summaryCounts"
        :transactionals="summaryTransactionals"
        :document-to="documentPath()"
        read-only
        class="max-w-4xl"
      />

      <!-- Withdrawn or postponed: nothing to answer any more -->
      <CommonEmptyState
        v-else-if="!document.can.position"
        icon="i-lucide-archive"
        :title="t('proponentReview.closed.title')"
        :description="t('proponentReview.closed.description')"
        variant="outline"
      >
        <template #action>
          <UButton
            :to="documentPath()"
            icon="i-lucide-arrow-left"
            :label="t('proponentReview.back')"
          />
        </template>
      </CommonEmptyState>

      <!-- Nothing to answer -->
      <CommonEmptyState
        v-else-if="items.length === 0"
        icon="i-lucide-message-square-dashed"
        :title="t('proponentReview.empty.title')"
        :description="t('proponentReview.empty.description')"
        variant="outline"
      >
        <template #action>
          <UButton
            :to="documentPath()"
            icon="i-lucide-arrow-left"
            :label="t('proponentReview.back')"
          />
        </template>
      </CommonEmptyState>

      <!-- Review -->
      <template v-else>
        <div class="max-w-4xl space-y-2">
          <div
            class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
          >
            <!-- Always rendered, so screen readers hear every change. -->
            <div aria-live="polite" aria-atomic="true" class="min-w-0">
              <p
                v-if="progress.total > 0"
                class="text-highlighted font-semibold tabular-nums"
              >
                {{
                  t(
                    "proponentReview.progress.answered",
                    { answered: progress.answered, total: progress.total },
                    progress.total,
                  )
                }}
              </p>
            </div>
            <USwitch
              v-model="onlyPending"
              :label="t('proponentReview.onlyPending')"
            />
          </div>
          <UProgress
            v-if="progress.total > 0"
            :model-value="progress.answered"
            :max="progress.total"
            size="sm"
            :color="
              progress.answered === progress.total ? 'success' : 'primary'
            "
            aria-hidden="true"
          />
          <div aria-live="polite" aria-atomic="true">
            <p
              v-if="progress.transactionals > 0"
              class="text-warning flex items-center gap-1.5 text-sm font-medium"
            >
              <UIcon
                name="i-lucide-hourglass"
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              {{
                t(
                  "proponentReview.progress.transactionals",
                  { count: progress.transactionals },
                  progress.transactionals,
                )
              }}
            </p>
          </div>
        </div>

        <div
          class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] xl:grid-cols-[minmax(0,1fr)_18rem]"
        >
          <div class="max-w-4xl min-w-0 space-y-4">
            <ProponentReviewSummary
              v-if="showSummary || !current"
              ref="summary"
              :counts="summaryCounts"
              :transactionals="summaryTransactionals"
              :document-to="documentPath()"
              @answer-left="answerLeft"
              @review-all="reviewAll"
            />

            <template v-else>
              <ProponentReviewTransactionalStep
                v-if="current.kind === 'transactional' && currentTarget"
                :key="current.id"
                ref="step"
                :amendment="current.amendment"
                :base="base"
                :sources="currentSources"
                :label-of="list.labelOf"
                :target="currentTarget"
                :busy="
                  busyAnswer === 'accepted' || busyAnswer === 'rejected'
                    ? busyAnswer
                    : null
                "
                :disabled="busy !== null"
                @answer="answerTransactional"
              />
              <ProponentReviewAmendmentStep
                v-else
                :key="current.id"
                ref="step"
                v-model:comment="comment"
                :amendment="current.amendment"
                :base="base"
                :busy="
                  busyAnswer === 'accept' ||
                  busyAnswer === 'reject' ||
                  busyAnswer === 'transact'
                    ? busyAnswer
                    : null
                "
                :disabled="busy !== null && busy.id !== current.id"
                :on-behalf-of="onBehalfOf"
                :visibility-note="visibilityNote"
                :comment-changed="commentChanged"
                :comment-busy="commentBusy"
                :transact-to="currentTransactTo"
                @answer="answerPosition"
                @save-comment="saveComment"
              />

              <nav
                class="bg-default/95 border-default sticky bottom-0 z-10 flex items-center justify-between gap-2 rounded-lg border px-2 py-2 backdrop-blur sm:px-3"
                :aria-label="t('proponentReview.nav.label')"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-arrow-left"
                  aria-keyshortcuts="k"
                  :disabled="!hasPrevious || busy !== null"
                  :label="t('common.previous')"
                  @click="goPrevious"
                />
                <span class="text-muted min-w-0 truncate text-sm tabular-nums">
                  {{ counterLabel }}
                </span>
                <UButton
                  color="neutral"
                  variant="outline"
                  trailing-icon="i-lucide-arrow-right"
                  aria-keyshortcuts="j"
                  :disabled="busy !== null"
                  :label="
                    hasNext ? t('common.next') : t('proponentReview.nav.finish')
                  "
                  @click="goNext"
                />
              </nav>
            </template>
          </div>

          <aside class="hidden lg:block">
            <div
              class="sticky top-0 max-h-[calc(100dvh-var(--ui-header-height)-6rem)] space-y-3 overflow-x-hidden overflow-y-auto"
            >
              <h3 class="text-highlighted px-2 text-sm font-semibold">
                {{ t("proponentReview.list.title") }}
              </h3>
              <ProponentReviewOutline
                :items="items"
                :current-id="showSummary ? null : currentId"
                :unsaved-ids="unsavedIds"
                @select="goTo($event, { focus: true })"
              />
            </div>
          </aside>
        </div>

        <USlideover
          v-model:open="listOpen"
          side="right"
          :title="t('proponentReview.list.title')"
          :description="t('proponentReview.list.description')"
          :ui="{ content: 'max-w-full sm:max-w-sm', body: 'p-3 sm:p-4' }"
          @after:leave="onListClosed"
        >
          <template #body>
            <ProponentReviewOutline
              :items="items"
              :current-id="showSummary ? null : currentId"
              :unsaved-ids="unsavedIds"
              @select="goTo($event, { focus: true })"
            />
          </template>
        </USlideover>
      </template>
    </template>
  </div>
</template>
