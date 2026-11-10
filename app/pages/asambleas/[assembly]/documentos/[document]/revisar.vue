<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { AmendmentDto } from "~~/shared/types/api";
import { transactionalSourceEligible } from "~/composables/amendment/transactional";
import {
  commentUnsaved,
  emptyReviewReason,
  fallbackStep,
  firstPendingId,
  goneKey,
  initialStep,
  isPositionAnswerable,
  isPositionReviewable,
  positionAnswer,
  positionBody,
  positionConflict,
  positionCounts,
  positionWaitCounts,
  presenterAnswerItems,
  proponentReviewItems,
  proponentReviewProgress,
  recordedPositionCounts,
  reviewSequence,
  savedKey,
  stepAfter,
  stepBefore,
  stepCounter,
  stepIndex,
  wasReopened,
  type PositionContext,
  type ProponentAnswer,
  type ProponentReviewItem,
} from "~/components/proponent-review/-review";

/**
 * The main presenter's review mode (inside the assembly hub), for the
 * member that presents the document as main presenter and for the Mesa
 * answering for it: one amendment at a time, with the change in large
 * type, its justification and three choices (Aceptar, Rechazar,
 * Transaccionar) with an optional comment. Pressing a choice saves it and
 * moves on. Only published amendments are answered: validated and made
 * visible by the Secretaría and, when late, admitted by the assembly
 * (positionWaitReason); a transactional joins them once it has replaced the
 * amendments it groups (its main authors accepted it, which is their job,
 * not the presenter's). What is still on its way shows under the progress
 * line, one sentence per reason. Once the document is voted nothing can be
 * answered: the page shows the answers on record.
 *
 * An answer the Mesa recorded on the main presenter's behalf says so, in
 * the step and in the co-presenters' list ("La Mesa, en nombre de CEUM,
 * ...").
 *
 * "Aceptar" says what it means under the document's rule: incorporated
 * into the text without a vote, or voted by the assembly. An incorporated
 * amendment stays in the review, and changing its answer before the final
 * vote takes it out of the text again.
 *
 * Co-presenters do not answer: they get a read-only list of the main
 * presenter's answers (who, what, when), as the Mesa's answers for it.
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
 * Each answer sends the position it saw (`positionUpdatedAt`): when someone
 * else answered meanwhile, the server refuses it, the list is refreshed and
 * the step says so, keeping the comment typed.
 *
 * Everything stays fresh through the hub's live stream (useDocument and
 * useDocumentAmendments subscribe to it). `?enmienda=<id>` opens on that
 * amendment.
 */

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

const actorMemberId = computed(() => member.value?.id ?? null);

// Access ------------------------------------------------------------------------

const isPublished = computed(
  () => Boolean(document.value?.baseVersion) && base.value.length > 0,
);
/** Voted: answers can no longer change (the server refuses them). */
const readOnly = computed(() => Boolean(document.value?.finalVote));
/** What the answering rule needs to know about the document. */
const positionContext = computed<PositionContext>(() => ({
  finalVoted: readOnly.value,
}));
/** Withdrawn or postponed: nothing to answer any more. */
const closed = computed(() => document.value?.status !== "published");

/** The actor's member presents the document as main presenter. */
const isMainPresenter = computed(
  () =>
    actorMemberId.value !== null &&
    document.value?.proponent?.id === actorMemberId.value,
);

/**
 * Whoever answers the amendments: the main presenter's member, or the Mesa.
 * The main presenter keeps the page when the document is withdrawn (it is
 * then told so), hence the member check besides `can.position`.
 */
const mayReview = computed(() => {
  const doc = document.value;
  if (!doc) return false;
  return doc.can.position || doc.can.moderate || isMainPresenter.value;
});

/** Presents the document with the main presenter, who answers for both. */
const readsAnswers = computed(() => {
  const doc = document.value;
  const id = actorMemberId.value;
  if (!doc || id === null || mayReview.value) return false;
  return doc.coProponents.some((coProponent) => coProponent.id === id);
});

/** The Mesa answers for the main presenter's member when it is not that member. */
const onBehalfOf = computed(() => {
  const proponent = document.value?.proponent ?? null;
  if (!proponent || proponent.id === actorMemberId.value) return null;
  return proponent;
});

/**
 * Who reads the answers, from the assembly's policy and, as on the server
 * (canSeePositions), its status: under the "session" policy everyone sees
 * them once the assembly is in session or closed.
 */
const visibilityNote = computed(() => {
  const policy = assembly.value?.settings.positionVisibility ?? "session";
  const started =
    assembly.value?.status === "in_session" ||
    assembly.value?.status === "closed";
  return t(
    `proponentReview.visibility.${policy === "session" && started ? "public" : policy}`,
  );
});

/** What an amendment the main presenter accepts becomes. */
const acceptedRule = computed(
  () => document.value?.acceptedAmendments ?? "vote",
);

/**
 * The actor may propose a transactional from the workspace: the same rule
 * as its "Proponer una transaccional" (canTransact in the document page),
 * where the Mesa, a member that may amend and the main presenter's member
 * (a party to what it negotiates, as on the server) qualify.
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
  return (
    doc.can.moderate ||
    (Boolean(member.value) && (doc.can.amend || isMainPresenter.value))
  );
});

/**
 * Where "Proponer la transaccional" goes for an amendment: the workspace's
 * composer with it preselected (`?transaccional=<id>`). Null when it cannot
 * be combined (the composer would drop it) or the actor cannot propose one.
 */
function transactLink(amendment: AmendmentDto): RouteLocationRaw | null {
  if (!canProposeTransactional.value) return null;
  if (!transactionalSourceEligible(amendment)) return null;
  return { path: documentPath(), query: { transaccional: amendment.id } };
}

/** An amendment in the document workspace. */
function amendmentLink(id: string): RouteLocationRaw {
  return { path: documentPath(), query: { enmienda: id } };
}

// Steps -------------------------------------------------------------------------

/** What is answered here: nothing once the document is voted. */
const items = computed<ProponentReviewItem[]>(() =>
  proponentReviewItems(
    list.amendments.value,
    acceptedRule.value,
    positionContext.value,
  ),
);
const progress = computed(() => proponentReviewProgress(items.value));
/**
 * Amendments still on their way to the main presenter: late ones the
 * assembly has not decided to treat, transactionals their main authors have
 * not accepted and, for the Mesa, those still with the Secretaría (to
 * validate or to publish).
 */
const waiting = computed(() =>
  positionWaitCounts(
    list.amendments.value,
    acceptedRule.value,
    positionContext.value,
  ),
);
/**
 * The sentence under "No hay enmiendas que responder": some on their way
 * (listed under it), all decided, or none presented yet.
 */
const emptyDescription = computed(() => {
  switch (emptyReviewReason(list.amendments.value, acceptedRule.value)) {
    case "waiting":
      return t("proponentReview.empty.waitingDescription");
    case "allDecided":
      return t("proponentReview.empty.allDecided");
    default:
      return t("proponentReview.empty.description");
  }
});
/**
 * The main presenter's answers, as a co-presenter reads them; once the
 * document is voted, withdrawn or postponed, only the answers given.
 */
const presenterItems = computed(() =>
  readsAnswers.value
    ? presenterAnswerItems(list.amendments.value, acceptedRule.value, {
        answeredOnly: readOnly.value || closed.value,
      })
    : [],
);

/** The review screen is on (not a guard, loading or empty state). */
const reviewing = computed(
  () =>
    Boolean(document.value?.can.position) &&
    !closed.value &&
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
  value: ProponentAnswer;
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
 * "Enmienda 5 de 12": where the step sits in the whole review. The total is
 * the progress line's, and hiding the answered ones does not turn it into
 * a countdown.
 */
const counterLabel = computed(() => {
  const counter = stepCounter(items.value, currentId.value);
  return counter ? t("proponentReview.nav.amendment", counter) : "";
});
const hasNext = computed(
  () => stepAfter(sequence.value, currentId.value) !== null,
);

function labelOf(item: Pick<ProponentReviewItem, "amendment">): string {
  return amendmentDisplayLabel(item.amendment) ?? t("proponentReview.noCode");
}

/**
 * The step on screen left the review without this visit answering it: says
 * why, from the amendment as it is now (`previous` is the list before the
 * change, which still shows it undecided).
 */
function notifyGone(id: string, previous: ProponentReviewItem | null): void {
  const fresh = list.byId.value.get(id) ?? null;
  const source = fresh ? { amendment: fresh } : previous;
  toast.add({
    id: `proponent-review-gone-${id}`,
    title: t(`proponentReview.${goneKey(fresh)}`, {
      label: source ? labelOf(source) : "",
    }),
    color: "info",
    icon: "i-lucide-info",
  });
}

/**
 * Where the step on screen sat, to land on its neighbour when it leaves (an
 * amendment decided, withdrawn or replaced by a transactional meanwhile).
 * Steps this visit answered out of the review leave on purpose: no notice
 * for those. Nor when the whole document left the debate (voted, withdrawn
 * or postponed): the page itself then says so. Nor when the amendment is
 * still answerable by its own rule: it then left because of the document
 * (its vote may reach the list before the document does) or the actor's
 * rights, not because someone decided it.
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
  // No context on purpose: the document may not be refreshed yet.
  const fresh = list.byId.value.get(id);
  if (
    !handled.has(id) &&
    !showSummary.value &&
    !readOnly.value &&
    !closed.value &&
    !(fresh && isPositionAnswerable(fresh, acceptedRule.value))
  ) {
    notifyGone(id, previous?.find((item) => item.id === id) ?? null);
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
        .filter((item) =>
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
          if (items.value.some((candidate) => candidate.id === item.id)) {
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
 * Someone else answered (or changed) the amendment since the actor loaded
 * it, so the server refused the answer: the list is refreshed and one
 * notice says what happened and what comes next. The comment typed stays,
 * to answer again if needed. The sequence watcher stays quiet about this
 * step, whose notice is this one.
 */
async function onConflict(
  item: ProponentReviewItem,
  sentPositionAt: string | null,
): Promise<void> {
  handled.add(item.id);
  // The document too: a final vote meanwhile also refuses the answer.
  await refreshAll();
  const stillInReview = items.value.some(
    (candidate) => candidate.id === item.id,
  );
  // Still here: should it leave later, the watcher says so as usual.
  if (stillInReview) handled.delete(item.id);
  const kind = positionConflict(
    sentPositionAt,
    list.byId.value.get(item.id),
    stillInReview,
    acceptedRule.value,
    positionContext.value,
  );
  if (kind === "gone") {
    notifyGone(item.id, item);
    return;
  }
  toast.add({
    id: `proponent-review-conflict-${item.id}`,
    title: t(`proponentReview.conflict.${kind}`, { label: labelOf(item) }),
    description: t(`proponentReview.conflict.${kind}Description`),
    color: "warning",
    icon: "i-lucide-refresh-ccw",
  });
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
  if (!item || busy.value) return;
  chosenId.value = item.id;
  busy.value = { id: item.id, value: answer, commentOnly: options.commentOnly };
  const before = item.amendment;
  const body = positionBody(answer, comment.value, before);
  try {
    const updated = await api.send<AmendmentDto>(
      `${amendmentUrl(item.id)}/position`,
      { method: "PUT", body },
    );
    // Where to go next, found before the answer may take the step out of
    // the review (it should not: incorporated ones stay to be changed).
    const next = stepAfter(sequence.value, item.id);
    if (
      !isPositionReviewable(updated, acceptedRule.value, positionContext.value)
    ) {
      handled.add(item.id);
    }
    list.upsert(updated);
    commentDrafts.delete(item.id);
    // "Transaccionar" moves on at once: the way to write the transactional
    // rides on the notice (and stays on the step for later).
    const transactTo =
      answer === "transact" && !options.commentOnly
        ? transactLink(updated)
        : null;
    const reopened = !options.commentOnly && wasReopened(before, updated);
    toast.add({
      id: "proponent-review-saved",
      title: options.commentOnly
        ? t("proponentReview.commentSaved", { label: labelOf(item) })
        : t(`proponentReview.saved.${savedKey(answer, updated)}`, {
            label: labelOf(item),
          }),
      description: reopened ? t("proponentReview.saved.reopened") : undefined,
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
      goTo(next, { focus: true });
    }
  } catch (error) {
    if (api.isConflict(error)) {
      await onConflict(item, body.positionUpdatedAt);
    } else {
      api.notifyError(error, "proponentReview.saveFailed");
    }
  } finally {
    busy.value = null;
  }
}

/** "Proponer la transaccional" on the amendment on screen, when it fits. */
const currentTransactTo = computed(() =>
  current.value ? transactLink(current.value.amendment) : null,
);
/** For a transactional: the amendments it replaced, as the actor sees them. */
const currentSources = computed(() =>
  current.value?.amendment.kind === "transactional"
    ? current.value.amendment.sourceIds
        .map((id) => list.byId.value.get(id))
        .filter((source): source is AmendmentDto => Boolean(source))
    : [],
);
/**
 * Transactionals over the amendment on screen still on their way (presented,
 * not yet replacing it), as the actor sees them: the same context the
 * document page shows.
 */
const currentPendingTransactionals = computed(() =>
  current.value
    ? current.value.amendment.transactionalIds
        .map((id) => list.byId.value.get(id))
        .filter(
          (transactional): transactional is AmendmentDto =>
            transactional?.status === "submitted",
        )
    : [],
);
/** How the amendment on screen relates to others ("Incompatible con ..."). */
const currentRelations = computed(() =>
  current.value ? list.relationsOf(current.value.id) : [],
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
  if (!item || !item.answered) return false;
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
  if (shortcutsBlocked(event) || showSummary.value || !current.value) return;
  void answerPosition(answer);
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

useHead({
  title: () =>
    document.value
      ? t(
          readsAnswers.value
            ? "proponentReview.coPresenter.pageTitle"
            : "proponentReview.pageTitle",
          { title: document.value.title },
        )
      : t("proponentReview.title"),
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- Loading -->
    <div v-if="pending" class="flex flex-col gap-4" role="status">
      <span class="sr-only">{{ t("workspace.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-4 w-32" />
      <USkeleton aria-hidden="true" class="h-8 w-2/3 max-w-xl" />
      <USkeleton aria-hidden="true" class="h-3 w-full max-w-4xl" />
      <USkeleton aria-hidden="true" class="h-80 w-full max-w-4xl" />
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
      <!-- The way back is the breadcrumb row, above -->
      <template v-if="errorStatusCode !== 404" #action>
        <UButton
          icon="i-lucide-refresh-ccw"
          :label="t('workspace.retry')"
          @click="refreshAll"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <header class="space-y-1">
        <!-- The way back to the document is the breadcrumb row, above -->
        <div v-if="reviewing" class="flex items-center justify-end gap-2">
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
        <h2 class="text-highlighted text-xl font-bold sm:text-2xl">
          {{
            readsAnswers
              ? t("proponentReview.coPresenter.heading")
              : t("proponentReview.title")
          }}
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

      <!-- Neither its main presenter, a co-presenter nor the Mesa -->
      <CommonEmptyState
        v-else-if="!mayReview && !readsAnswers"
        icon="i-lucide-lock"
        :title="t('proponentReview.noAccess.title')"
        :description="t('proponentReview.noAccess.description')"
        variant="outline"
      />

      <!-- Amendments loading -->
      <div
        v-else-if="list.pending.value && !list.data.value"
        class="flex max-w-4xl flex-col gap-4"
        role="status"
      >
        <span class="sr-only">{{ t("proponentReview.loading") }}</span>
        <USkeleton aria-hidden="true" class="h-3 w-full" />
        <USkeleton aria-hidden="true" class="h-80 w-full" />
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

      <!--
        Co-presenter: the main presenter's answers, read only (in the past
        tense once the document is voted, withdrawn or postponed)
      -->
      <ProponentReviewPresenterAnswers
        v-else-if="readsAnswers"
        :items="presenterItems"
        :presenter="document.proponent"
        :accepted-amendments="acceptedRule"
        :waiting="waiting"
        :amendment-to="amendmentLink"
        :document-to="documentPath()"
        :read-only="readOnly"
        :closed="closed"
        class="max-w-4xl"
      />

      <!-- Voted: what was answered, nothing to change -->
      <ProponentReviewSummary
        v-else-if="readOnly"
        :counts="summaryCounts"
        :accepted-amendments="acceptedRule"
        :document-to="documentPath()"
        read-only
        class="max-w-4xl"
      />

      <!-- Withdrawn or postponed: nothing to answer any more -->
      <CommonEmptyState
        v-else-if="closed"
        icon="i-lucide-archive"
        :title="t('proponentReview.closed.title')"
        :description="t('proponentReview.closed.description')"
        variant="outline"
      />

      <!-- Nothing to answer -->
      <CommonEmptyState
        v-else-if="items.length === 0"
        icon="i-lucide-message-square-dashed"
        :title="t('proponentReview.empty.title')"
        :description="emptyDescription"
        variant="outline"
      >
        <ProponentReviewWaiting :counts="waiting" class="text-start" />
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
          <ProponentReviewWaiting :counts="waiting" />
        </div>

        <div
          class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] xl:grid-cols-[minmax(0,1fr)_18rem]"
        >
          <div class="max-w-4xl min-w-0 space-y-4">
            <ProponentReviewSummary
              v-if="showSummary || !current"
              ref="summary"
              :counts="summaryCounts"
              :accepted-amendments="acceptedRule"
              :document-to="documentPath()"
              @answer-left="answerLeft"
              @review-all="reviewAll"
            />

            <template v-else>
              <ProponentReviewAmendmentStep
                :key="current.id"
                ref="step"
                v-model:comment="comment"
                :amendment="current.amendment"
                :base="base"
                :accepted-amendments="acceptedRule"
                :sources="currentSources"
                :pending-transactionals="currentPendingTransactionals"
                :relations="currentRelations"
                :label-of="list.labelOf"
                :busy="busyAnswer"
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
              class="sticky top-0 max-h-[calc(100dvh-var(--shell-banner-height,0px)-var(--ui-header-height)-var(--shell-breadcrumb-height,0px)-6rem)] space-y-3 overflow-x-hidden overflow-y-auto"
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
