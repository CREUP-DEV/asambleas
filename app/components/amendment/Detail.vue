<script setup lang="ts">
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  DocumentDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { blockLabels } from "~~/shared/utils/content/render";
import { canChangeAmendmentAuthors } from "~~/shared/utils/amendmentAuthors";
import { canReclassifyAmendment } from "~~/shared/utils/amendmentReclassify";
import { firstTouchedBlockId } from "~~/shared/utils/content/ops";
import {
  transactionalAuthorTurn,
  transactionalClosure,
  transactionalGroupSources,
  transactionalLinksOf,
  transactionalProgressMessage,
  transactionalProgressOf,
  transactionalRejectedBy,
  transactionalRejectedByAuthors,
  transactionalSourceEligible,
  transactionalsOverSource,
} from "~/composables/amendment/transactional";
import { useTransactionalProgressText } from "~/composables/amendment/useTransactionalProgressText";
import {
  amendmentAuthorsInOrder,
  amendmentErrorKey,
  amendmentErrorReasons,
  amendmentHistoryVersion,
  amendmentLateOnSend,
  amendmentLateState,
  amendmentReviewView,
  amendmentSentNotice,
  amendmentStatusLine,
  showAmendmentAdmission,
  type AmendmentNeighbours,
  type AmendmentOverlap,
  type AmendmentRelationView,
} from "~/composables/amendment/workspace";

/**
 * One amendment, read on its own. What matters comes first, in this order:
 * 1. its code, who presents it and ONE status (where it stands with the
 *    Secretaría while that says more, what a transactional waits for, or
 *    how it ended: the same rule as its card);
 * 2. what changes: only the passage it touches, with a little context.
 *    "Ver en el documento" asks the page to show the change in the full
 *    text (`locate`); the text never changes view by itself;
 * 3. why: its justification;
 * 4. what is the viewer's turn: the Secretaría's review (validate, publish,
 *    ask for a correction, record the assembly's decision on a late one,
 *    and for an author "Corregir y volver a enviar"), moving it between
 *    "de forma" and "de contenido" (those who review amendments, while it
 *    is presented and undecided), the main presenter's answer (or the
 *    Mesa's for it), a transactional over it waiting for the viewer as its
 *    main author, and the parties of a transactional when the viewer is
 *    one of them or the Mesa records their answers. The author's own
 *    actions (edit, send, withdraw, delete a draft) and "Proponer una
 *    transaccional" are buttons in the footer.
 *
 * Everything else is folded under "Ver detalles": authors and dates (late,
 * admission, change typology), outcome and vote, overlaps, transactional
 * links and the answers that are not the viewer's to give, relations and
 * the history. A panel that asks the viewer to act is never folded.
 *
 * Above it all, "Volver a la lista" and, when the page says where the
 * amendment sits in the list on screen (`nav`), "Anterior · 3 de 17 ·
 * Siguiente", also with the left and right arrows and K / J. The shortcuts
 * are off while typing, inside a dialog, menu, list box or tab list (where
 * the keys mean something else), and while a request runs or a
 * confirmation is open.
 *
 * Transactionals proposed over this amendment are listed with what its main
 * author answered (who, what, when): the main author answers them here,
 * its co-authors read the answer, also after the transactional was decided.
 * Only the first one waiting for the viewer's answer gets the primary
 * button. On a transactional, the main authors of the amendments it would
 * replace answer in its list of parties, and its history names who
 * answered. Once closed, its outcome says why: who rejected it (from its
 * acceptances, as its outcome note is left for the Mesa's own words), or
 * which amendment it groups was settled or replaced meanwhile, when no
 * note says it. A replaced amendment's outcome names the transactional that
 * replaced it. A draft (new, or sent back for correction) has no answer
 * from the main presenter to show. A draft sent back for correction has
 * one way forward, "Corregir y volver a enviar" in the review panel: the
 * composer shows the note and sends it, so the footer offers no direct
 * send.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    base: Block[];
    document: DocumentDto;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    labelOf: (id: string) => string;
    relations: AmendmentRelationView[];
    /**
     * The other amendments of the document the viewer sees (to relate it,
     * and to look up the transactionals over it and the ones it combines).
     */
    candidates: AmendmentDto[];
    overlaps?: AmendmentOverlap[];
    /**
     * Where it sits in the list on screen, to move to the one before or
     * after it. None when the list does not hold it.
     */
    nav?: AmendmentNeighbours | null;
    /** GET .../decisions of the assembly, for admission votes in the history. */
    decisionsUrl?: string;
    /** The viewer may propose a transactional on this document. */
    canTransact?: boolean;
  }>(),
  {
    overlaps: () => [],
    nav: null,
    decisionsUrl: undefined,
    canTransact: false,
  },
);

const emit = defineEmits<{
  close: [];
  select: [id: string];
  /** "Ver en el documento": show its change in the full text. */
  locate: [amendment: AmendmentDto];
  edit: [amendment: AmendmentDto];
  /** Open the transactional composer on these amendments. */
  transact: [ids: string[]];
  updated: [amendment: AmendmentDto];
  /** The whole list, after the Secretaría validated or published it. */
  replaced: [dto: DocumentAmendmentsDto];
  removed: [id: string];
  /** Something changed elsewhere (relations, a conflict): refetch. */
  changed: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const headingId = useId();
const detailsId = useId();
const root = useTemplateRef<HTMLElement>("root");
const heading = useTemplateRef<HTMLElement>("heading");
const { member } = useMe();

const url = computed(() => `${props.amendmentsUrl}/${props.amendment.id}`);
const label = computed(() => props.labelOf(props.amendment.id));

const busy = ref<"submit" | "withdraw" | "delete" | null>(null);
const detailsOpen = ref(false);
const confirming = ref<"withdraw" | "delete" | null>(null);
const reasons = ref<string[]>([]);

watch(
  () => props.amendment.id,
  () => {
    confirming.value = null;
    reasons.value = [];
    detailsOpen.value = false;
  },
);

// One after another -------------------------------------------------------------

/** "3 de 17", when the list on screen holds this amendment. */
const position = computed(() =>
  props.nav && props.nav.index >= 0
    ? { n: props.nav.index + 1, total: props.nav.total }
    : null,
);

/**
 * Moves to a neighbour. The pressed button stays under the pointer; when it
 * is disabled at the end of the list, focus goes to the heading instead of
 * being lost.
 */
async function go(id: string | null | undefined): Promise<void> {
  if (!id) return;
  emit("select", id);
  await nextTick();
  const active = globalThis.document?.activeElement;
  if (
    !active ||
    active === globalThis.document.body ||
    (active instanceof HTMLButtonElement && active.disabled)
  ) {
    heading.value?.focus();
  }
}

/**
 * Shortcuts act once per press, never while a request runs or a
 * confirmation is open, and not inside a dialog, menu, list box, tab list
 * or radio group (where arrows and letters mean something else). The
 * slideover that holds this detail on narrow screens is a dialog too: that
 * one does not block them. Inputs and textareas are skipped by
 * defineShortcuts itself.
 */
function shortcutsBlocked(event?: KeyboardEvent): boolean {
  if (event?.repeat || !props.nav || busy.value || confirming.value) {
    return true;
  }
  const active = import.meta.client ? globalThis.document.activeElement : null;
  const scope = active?.closest(
    '[role="dialog"], [role="menu"], [role="listbox"], [role="tablist"], [role="radiogroup"]',
  );
  if (!scope) return false;
  return !(
    scope.getAttribute("role") === "dialog" &&
    root.value !== null &&
    scope.contains(root.value)
  );
}

function shortcutGo(
  event: KeyboardEvent | undefined,
  direction: "previous" | "next",
): void {
  if (shortcutsBlocked(event)) return;
  void go(props.nav?.[direction]);
}

defineShortcuts({
  arrowleft: (event?: KeyboardEvent) => shortcutGo(event, "previous"),
  arrowright: (event?: KeyboardEvent) => shortcutGo(event, "next"),
  k: (event?: KeyboardEvent) => shortcutGo(event, "previous"),
  j: (event?: KeyboardEvent) => shortcutGo(event, "next"),
});

// What it is --------------------------------------------------------------------

const decided = computed(
  () =>
    props.amendment.status !== "draft" &&
    props.amendment.status !== "submitted",
);
// The shared clock ticks every minute, so a window that closes while the
// page is open is seen as closed, and hydration matches the server.
const now = useAppNow();
const windowClosed = computed(() => {
  const closesAt = toDate(props.document.window.closesAt);
  return Boolean(closesAt && closesAt.getTime() <= now.value);
});
const canManageRelations = computed(
  () =>
    !props.document.finalVote &&
    (props.amendment.can.moderate ||
      props.amendment.can.review ||
      props.document.can.position),
);
/**
 * Not on a draft: it can only be answered once published, and one sent back
 * for correction still carries the row from its first sending.
 */
const showPosition = computed(
  () =>
    props.amendment.status !== "draft" &&
    (props.amendment.position !== null || props.amendment.can.position),
);
const showRelations = computed(
  () =>
    props.amendment.status !== "draft" &&
    (props.relations.length > 0 || canManageRelations.value),
);
const review = computed(() => amendmentReviewView(props.amendment));
/** "Corregir y volver a enviar" already opens the composer, which sends it. */
const fixing = computed(() => review.value?.key === "correction");
const showEdit = computed(() => props.amendment.can.edit && !fixing.value);
const showSubmit = computed(() => props.amendment.can.submit && !fixing.value);
/** Same timing rule as the server: a corrected one keeps its first timing. */
const lateOnSend = computed(() =>
  amendmentLateOnSend(props.amendment, windowClosed.value),
);
/** "Parcial" is the usual kind: only the others are worth a badge. */
const showKind = computed(() => props.amendment.kind !== "partial");

/** This amendment can be combined into a transactional by the viewer. */
const transactable = computed(
  () => props.canTransact && transactionalSourceEligible(props.amendment),
);
/** This one and the amendments on the same passage that can be combined. */
const overlapSources = computed(() => {
  if (!transactable.value) return [];
  const others = new Set(props.overlaps.map((overlap) => overlap.id));
  return transactionalGroupSources([
    props.amendment,
    ...props.candidates.filter((candidate) => others.has(candidate.id)),
  ]);
});

/** Late and validated: the review panel says the assembly has to decide. */
const awaitingDecision = computed(
  () => amendmentLateState(props.amendment) === "awaiting_decision",
);

const where = computed(() => {
  // The first change in the order of the text, as the list sorts it.
  const id = firstTouchedBlockId(props.amendment.ops, props.base);
  if (id === null) return null;
  const first = blockLabels(props.base).get(id);
  if (!first) return null;
  const paragraph =
    first.paragraph > 0
      ? t("amendment.detail.paragraph", { n: first.paragraph })
      : null;
  return [first.heading, paragraph].filter(Boolean).join(" · ") || null;
});

/** Main author first; marked only when there are several. */
const authors = computed(() => amendmentAuthorsInOrder(props.amendment));

/**
 * The one status at the top: what a presented transactional waits for (as
 * in its card, also once a main author rejected it), else where it stands
 * with the Secretaría while that says more, else its status.
 */
const progress = computed(() =>
  transactionalProgressOf(props.amendment, member.value?.id ?? null, statusOf),
);
const hasProgress = computed(
  () =>
    progress.value !== null &&
    transactionalProgressMessage(progress.value, "long") !== null,
);
const statusLine = computed(() => amendmentStatusLine(props.amendment));

/** Those who review amendments may move it between form and content. */
const canReclassify = computed(
  () =>
    props.amendment.can.review &&
    canReclassifyAmendment(props.amendment, Boolean(props.document.finalVote)),
);
/** Those who review amendments may correct who presents it. */
const canChangeAuthors = computed(
  () =>
    props.amendment.can.review &&
    canChangeAmendmentAuthors(
      props.amendment,
      Boolean(props.document.finalVote),
    ),
);
/** The viewer answers it (the main presenter, or the Mesa for it). */
const positionTurn = computed(
  () => showPosition.value && props.amendment.can.position,
);
/** A transactional a main author rejected (closed, the originals carry on). */
const rejectedByAuthors = computed(() =>
  transactionalRejectedByAuthors(props.amendment),
);
const { join } = useTransactionalProgressText();
/** "CEUM y CAUB": who closed it by rejecting it, for its outcome. */
const rejectedBy = computed(() =>
  join(
    transactionalRejectedBy(props.amendment).map((member) => member.acronym),
  ),
);

const byId = computed(
  () =>
    new Map(
      [props.amendment, ...props.candidates].map((item) => [item.id, item]),
    ),
);
function statusOf(id: string) {
  return byId.value.get(id)?.status;
}
/** The whole row, so a closure is matched to when its sources were settled. */
function amendmentOf(id: string): AmendmentDto | undefined {
  return byId.value.get(id);
}
/**
 * Closed on its own (an amendment it groups was settled or replaced at that
 * same moment) with no note saying so: its outcome names that amendment.
 */
const closedBecause = computed(() => {
  if (props.amendment.outcomeNote) return null;
  const closure = transactionalClosure(props.amendment, amendmentOf);
  if (!closure?.sourceId) return null;
  return t(`amendment.detail.closedOnItsOwn.${closure.reason}`, {
    source: props.labelOf(closure.sourceId),
  });
});
/** The transactionals that replaced it (it is `transacted`), for its outcome. */
const replacedBy = computed(
  () => transactionalLinksOf(props.amendment, byId.value).replacedBy,
);
/** History labels: only the amendments the viewer sees (else the event's code). */
function historyLabelOf(id: string): string | null {
  return byId.value.has(id) ? props.labelOf(id) : null;
}
/** The amendments a transactional combines, as far as the viewer sees them. */
const sources = computed(() =>
  props.amendment.sourceIds
    .map((id) => byId.value.get(id))
    .filter((item) => item !== undefined),
);
/**
 * Transactionals over this amendment with its main author's answer: open
 * ones, ones a rejection closed, and any it already answered (its
 * co-authors keep seeing who answered, what and when).
 */
const transactionalsOver = computed(() =>
  transactionalsOverSource(props.amendment, byId.value),
);
/** The first one waiting for the viewer's answer: the primary action. */
const firstTurnId = computed(
  () =>
    transactionalsOver.value.find((item) =>
      transactionalAuthorTurn(item, props.amendment, member.value?.id ?? null),
    )?.id ?? null,
);
/** The ones waiting for the viewer's answer as main author: never folded. */
const transactionalsToAnswer = computed(() =>
  transactionalsOver.value.filter((item) =>
    transactionalAuthorTurn(item, props.amendment, member.value?.id ?? null),
  ),
);
/** The rest: answered, closed, or someone else's to answer. */
const transactionalsAnswered = computed(() => {
  const waiting = new Set(transactionalsToAnswer.value.map((item) => item.id));
  return transactionalsOver.value.filter((item) => !waiting.has(item.id));
});
/**
 * A transactional whose parties still answer, seen by one of them or by the
 * Mesa, which records the answers given in the room: its list of parties
 * is the viewer's turn.
 */
const acceptancesTurn = computed(
  () =>
    props.amendment.kind === "transactional" &&
    props.amendment.status === "submitted" &&
    (props.amendment.can.accept ||
      (props.amendment.can.moderate &&
        props.amendment.acceptances.some(
          (party) => party.decision === "pending",
        ))),
);
/** "Incluida en": the other transactionals, not shown with an answer below. */
const transactedInIds = computed(() => {
  const shown = new Set(transactionalsOver.value.map((item) => item.id));
  return props.amendment.transactionalIds.filter((id) => !shown.has(id));
});
/**
 * Who the history may name by id: the parties, the authors and the
 * document's presenters (the Mesa answers for the main one).
 */
const historyMembers = computed(() => [
  ...props.amendment.acceptances.map((party) => party.member),
  ...props.amendment.authors,
  ...(props.document.proponent ? [props.document.proponent] : []),
  ...props.document.coProponents,
]);

/** Positions, acceptances and relations do not move updatedAt: fold them in. */
const historyVersion = computed(() =>
  amendmentHistoryVersion(
    props.amendment,
    props.relations.map((view) => view.relation.id),
  ),
);

function handleError(error: unknown, fallbackKey: string): void {
  reasons.value = amendmentErrorReasons(error);
  api.notifyError(error, fallbackKey);
  if (api.isConflict(error)) emit("changed");
}

async function submit(): Promise<void> {
  busy.value = "submit";
  reasons.value = [];
  try {
    const updated = await api.send<AmendmentDto>(`${url.value}/submit`);
    const notice = amendmentSentNotice(updated);
    toast.add({
      title:
        notice === "public"
          ? t("amendment.detail.presented")
          : t("amendment.detail.submitted"),
      description: t(
        notice === "public"
          ? "amendment.detail.presentedDescription"
          : notice === "review_late"
            ? "amendment.detail.submittedLate"
            : "amendment.detail.submittedDescription",
      ),
      color: notice === "review_late" ? "warning" : "success",
      icon: "i-lucide-send",
    });
    emit("updated", updated);
  } catch (error) {
    handleError(error, "amendment.detail.submitFailed");
  } finally {
    busy.value = null;
  }
}

async function withdraw(): Promise<void> {
  busy.value = "withdraw";
  try {
    const updated = await api.send<AmendmentDto>(`${url.value}/withdraw`);
    confirming.value = null;
    toast.add({
      title: t("amendment.detail.withdrawn"),
      color: "success",
      icon: "i-lucide-undo-2",
    });
    emit("updated", updated);
  } catch (error) {
    handleError(error, "amendment.detail.withdrawFailed");
  } finally {
    busy.value = null;
  }
}

/**
 * Sent back to its authors: it is a draft again and leaves the list, so the
 * detail closes (the page gives focus back to the list).
 */
function onCorrected(updated: AmendmentDto): void {
  emit("updated", updated);
  emit("close");
}

/** The review panel has nothing left to show: keep focus in the detail. */
function onReviewSettled(): void {
  heading.value?.focus();
}

defineExpose({
  /** For the page, when it opens this amendment in place of something else. */
  focusHeading: () => heading.value?.focus(),
});

async function remove(): Promise<void> {
  busy.value = "delete";
  try {
    await api.send(url.value, { method: "DELETE" });
    confirming.value = null;
    toast.add({
      title: t("amendment.detail.deleted"),
      color: "success",
      icon: "i-lucide-trash-2",
    });
    emit("removed", props.amendment.id);
  } catch (error) {
    handleError(error, "amendment.detail.deleteFailed");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <article ref="root" class="flex flex-col gap-5" :aria-labelledby="headingId">
    <!-- Back to the list, and the amendments before and after this one. -->
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <UButton
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        size="sm"
        class="-ms-2"
        :label="t('amendment.detail.back')"
        @click="emit('close')"
      />
      <nav
        v-if="position"
        class="flex items-center gap-1"
        :aria-label="t('amendment.detail.navLabel')"
      >
        <UButton
          icon="i-lucide-chevron-left"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-keyshortcuts="ArrowLeft K"
          :disabled="!nav?.previous || busy !== null"
          :label="t('common.previous')"
          @click="go(nav?.previous)"
        />
        <span
          class="text-muted text-sm whitespace-nowrap tabular-nums"
          aria-live="polite"
        >
          {{ t("amendment.detail.position", position) }}
        </span>
        <UButton
          trailing-icon="i-lucide-chevron-right"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-keyshortcuts="ArrowRight J"
          :disabled="!nav?.next || busy !== null"
          :label="t('common.next')"
          @click="go(nav?.next)"
        />
      </nav>
    </div>

    <!-- 1. Code, who presents it and one status. -->
    <header class="flex flex-col gap-2">
      <div class="min-w-0">
        <h2
          :id="headingId"
          ref="heading"
          tabindex="-1"
          class="text-highlighted text-lg font-semibold tabular-nums outline-none"
        >
          {{ label }}
        </h2>
        <p v-if="where" class="text-muted truncate text-sm">{{ where }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <CommonMemberBadge
          v-if="authors.main"
          :member="authors.main"
          size="xs"
          show-name
        />
        <span v-if="authors.others.length > 0" class="text-muted text-sm">
          {{
            t(
              "amendment.card.moreAuthors",
              { count: authors.others.length },
              authors.others.length,
            )
          }}
        </span>
        <!-- "Parcial" is the usual kind: only the others are named. -->
        <UBadge
          v-if="showKind"
          color="neutral"
          variant="outline"
          :label="t(`amendment.kinds.${amendment.kind}`)"
        />
        <!-- The account's own mark; nothing for one that is not published. -->
        <ReadToggle :id="amendment.id" kind="amendment" class="ms-auto" />
      </div>
      <TransactionalProgress
        v-if="hasProgress"
        :amendment="amendment"
        :label-of="labelOf"
        :status-of="statusOf"
      />
      <div v-else class="flex items-center">
        <UBadge
          v-if="statusLine.type === 'review'"
          :color="statusLine.view.color"
          variant="subtle"
          :icon="statusLine.view.icon"
          :label="t(`amendment.review.badges.${statusLine.view.key}`)"
        />
        <CommonStatusBadge v-else kind="amendment" :value="amendment.status" />
      </div>
    </header>

    <UAlert
      v-if="reasons.length > 0"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      :title="t('amendment.composer.errorsTitle')"
    >
      <template #description>
        <ul class="list-disc ps-5">
          <li v-for="reason in reasons" :key="reason">
            {{ t(amendmentErrorKey(reason)) }}
          </li>
        </ul>
      </template>
    </UAlert>

    <!-- 2. What changes: the passage only. -->
    <section class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.whatChanges") }}
      </h3>
      <p v-if="amendment.globalReplace" class="text-sm">
        <UIcon
          name="i-lucide-replace-all"
          class="text-muted me-1 size-4 align-middle"
          aria-hidden="true"
        />
        {{
          t("amendment.detail.globalReplace", {
            find: amendment.globalReplace.find,
            replace: amendment.globalReplace.replace,
          })
        }}
        <span class="text-muted">
          ·
          {{
            t(
              "amendment.detail.occurrences",
              { count: amendment.ops.length },
              amendment.ops.length,
            )
          }}
        </span>
      </p>
      <div class="border-default rounded-md border p-3 sm:p-4">
        <ContentAmendmentDiff
          :id="amendment.id"
          :base="base"
          :ops="amendment.ops"
          :context="1"
        >
          <template v-if="amendment.kind === 'totality_return'" #note>
            <UAlert
              color="neutral"
              variant="subtle"
              icon="i-lucide-file-x"
              :title="t('amendment.kinds.totality_return')"
              :description="t('amendment.detail.returnNote')"
            />
          </template>
        </ContentAmendmentDiff>
      </div>
      <UButton
        v-if="amendment.ops.length > 0"
        class="self-start"
        icon="i-lucide-file-search"
        color="neutral"
        variant="outline"
        size="sm"
        :label="t('amendment.detail.showInText')"
        @click="emit('locate', amendment)"
      />
    </section>

    <!-- 3. Why. -->
    <section class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.why") }}
      </h3>
      <p
        v-if="amendment.justification"
        class="content-font text-default text-sm whitespace-pre-line"
      >
        {{ amendment.justification }}
      </p>
      <p v-else class="text-muted text-sm">
        {{ t("amendment.detail.noJustification") }}
      </p>
    </section>

    <!-- 4. What is the viewer's turn. Never folded. -->
    <AmendmentReviewPanel
      :amendment="amendment"
      :amendments-url="amendmentsUrl"
      :label-of="labelOf"
      :status-of="statusOf"
      @edit="emit('edit', $event)"
      @replaced="emit('replaced', $event)"
      @corrected="onCorrected"
      @changed="emit('changed')"
      @settled="onReviewSettled"
    />

    <AmendmentReclassify
      v-if="canReclassify"
      :amendment="amendment"
      :url="url"
      @updated="emit('updated', $event)"
      @conflict="emit('changed')"
    />

    <AmendmentAuthorsChange
      v-if="canChangeAuthors"
      :amendment="amendment"
      :url="url"
      @updated="emit('updated', $event)"
      @conflict="emit('changed')"
    />

    <AmendmentPositionPanel
      v-if="positionTurn"
      :amendment="amendment"
      :url="url"
      :document="document"
      @updated="emit('updated', $event)"
      @conflict="emit('changed')"
    />

    <!-- Transactionals over this one that wait for the viewer's answer. -->
    <section
      v-if="transactionalsToAnswer.length > 0"
      class="flex flex-col gap-2"
    >
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.transactionalsOver") }}
      </h3>
      <TransactionalAuthorAnswer
        v-for="item in transactionalsToAnswer"
        :key="item.id"
        :transactional="item"
        :source="amendment"
        :primary="item.id === firstTurnId"
        :amendments-url="amendmentsUrl"
        :actor-member-id="member?.id ?? null"
        :label-of="labelOf"
        :status-of="statusOf"
        :amendment-of="amendmentOf"
        @updated="emit('updated', $event)"
        @conflict="emit('changed')"
        @select="emit('select', $event)"
      />
    </section>

    <AmendmentAcceptances
      v-if="acceptancesTurn"
      :amendment="amendment"
      :url="url"
      :actor-member-id="member?.id ?? null"
      :sources="sources"
      :label-of="labelOf"
      @updated="emit('updated', $event)"
      @conflict="emit('changed')"
    />

    <!-- Everything else, folded. -->
    <div class="flex flex-col gap-4">
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        class="self-start"
        :icon="detailsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="
          detailsOpen
            ? t('amendment.detail.hideDetails')
            : t('amendment.detail.showDetails')
        "
        :aria-expanded="detailsOpen"
        :aria-controls="detailsId"
        @click="detailsOpen = !detailsOpen"
      />
      <div v-if="detailsOpen" :id="detailsId" class="flex flex-col gap-5">
        <section class="flex flex-col gap-2">
          <h3 class="text-highlighted text-sm font-semibold">
            {{ t("amendment.detail.authors") }}
          </h3>
          <div class="flex flex-col gap-1.5">
            <div v-if="authors.main" class="flex flex-wrap items-center gap-2">
              <CommonMemberBadge :member="authors.main" size="xs" show-name />
              <span v-if="authors.marked" class="text-dimmed text-xs">
                {{ t("amendment.detail.mainAuthor") }}
              </span>
            </div>
            <CommonMemberBadge
              v-for="author in authors.others"
              :key="author.id"
              :member="author"
              size="xs"
              show-name
            />
            <p v-if="amendment.submittedAt" class="text-muted text-xs">
              {{
                t("amendment.detail.submittedAt", {
                  date: formatDateTime(amendment.submittedAt, { locale }),
                })
              }}
            </p>
            <div
              v-if="
                amendment.late ||
                amendment.changeKinds.length > 0 ||
                (!awaitingDecision && showAmendmentAdmission(amendment))
              "
              class="flex flex-wrap items-center gap-1.5"
            >
              <UBadge
                v-if="amendment.late"
                color="warning"
                variant="subtle"
                size="sm"
                icon="i-lucide-clock-alert"
                :label="
                  amendment.admission === 'admitted'
                    ? t('amendment.lateAdmitted')
                    : t('amendment.late')
                "
              />
              <CommonStatusBadge
                v-if="!awaitingDecision && showAmendmentAdmission(amendment)"
                kind="admission"
                :value="amendment.admission"
                size="sm"
              />
              <UBadge
                v-for="change in amendment.changeKinds"
                :key="change"
                color="neutral"
                variant="soft"
                size="sm"
                :label="t(`amendment.changeKinds.${change}`)"
              />
            </div>
          </div>
        </section>

        <section v-if="decided" class="flex flex-col gap-2">
          <h3 class="text-highlighted text-sm font-semibold">
            {{ t("amendment.detail.outcome") }}
          </h3>
          <p
            v-if="
              amendment.status === 'approved' &&
              amendment.approvalMethod === 'proponent'
            "
            class="text-sm"
          >
            {{
              amendment.position?.recordedBy === "mesa"
                ? t("amendment.detail.approvedByMesa")
                : t("amendment.detail.approvedByPresenter")
            }}
          </p>
          <p
            v-else-if="
              amendment.status === 'approved' && amendment.approvalMethod
            "
            class="text-sm"
          >
            {{
              t("amendment.detail.approvedBy", {
                method: t(
                  `amendment.approvalMethods.${amendment.approvalMethod}`,
                ),
              })
            }}
          </p>
          <!-- Replaced: which transactional took its place. -->
          <p v-else-if="amendment.status === 'transacted'" class="text-sm">
            {{
              replacedBy.length > 0
                ? t(
                    "amendment.detail.replacedBy",
                    { list: join(replacedBy.map((id) => labelOf(id))) },
                    replacedBy.length,
                  )
                : t("amendment.detail.replacedByUnknown")
            }}
          </p>
          <!-- Closed by a main author's rejection: who said no. -->
          <p v-if="rejectedByAuthors && rejectedBy" class="text-sm">
            {{
              t("amendment.detail.rejectedByAuthors", { members: rejectedBy })
            }}
          </p>
          <p v-else-if="closedBecause" class="text-sm">
            {{ closedBecause }}
          </p>
          <p v-if="amendment.decidedAt" class="text-muted text-xs">
            {{
              t("amendment.detail.decidedAt", {
                date: formatDateTime(amendment.decidedAt, { locale }),
              })
            }}
          </p>
          <p
            v-if="amendment.outcomeNote"
            class="text-default text-sm whitespace-pre-line"
          >
            {{ amendment.outcomeNote }}
          </p>
          <AmendmentVoteSummary
            v-if="amendment.outcomeVote"
            :vote="amendment.outcomeVote"
          />
        </section>

        <!-- The main presenter's answer, for those who only read it. -->
        <AmendmentPositionPanel
          v-if="showPosition && !positionTurn"
          :amendment="amendment"
          :url="url"
          :document="document"
          @updated="emit('updated', $event)"
          @conflict="emit('changed')"
        />

        <section v-if="overlaps.length > 0" class="flex flex-col gap-2">
          <h3 class="text-highlighted text-sm font-semibold">
            {{ t("amendment.detail.overlaps") }}
          </h3>
          <ul class="flex flex-wrap gap-2">
            <li v-for="overlap in overlaps" :key="overlap.id">
              <UButton
                size="xs"
                :color="
                  overlap.kind === 'same_position' ? 'neutral' : 'warning'
                "
                variant="soft"
                icon="i-lucide-layers"
                :label="`${labelOf(overlap.id)} · ${t(`amendment.detail.overlapKinds.${overlap.kind}`)}`"
                @click="emit('select', overlap.id)"
              />
            </li>
          </ul>
          <UButton
            v-if="overlapSources.length >= 2"
            class="self-start"
            icon="i-lucide-git-merge"
            color="neutral"
            variant="outline"
            size="xs"
            :label="t('amendment.detail.transactOverlaps')"
            @click="emit('transact', overlapSources)"
          />
        </section>

        <section
          v-if="
            amendment.sourceIds.length > 0 ||
            transactedInIds.length > 0 ||
            transactionalsAnswered.length > 0
          "
          class="flex flex-col gap-2"
        >
          <h3 class="text-highlighted text-sm font-semibold">
            {{ t("amendment.detail.transactional") }}
          </h3>
          <div
            v-if="amendment.sourceIds.length > 0"
            class="flex flex-wrap items-center gap-2"
          >
            <span class="text-muted text-sm">{{
              t("amendment.detail.sources")
            }}</span>
            <UButton
              v-for="id in amendment.sourceIds"
              :key="id"
              size="xs"
              color="secondary"
              variant="soft"
              icon="i-lucide-git-merge"
              :label="labelOf(id)"
              @click="emit('select', id)"
            />
          </div>
          <div
            v-if="transactedInIds.length > 0"
            class="flex flex-wrap items-center gap-2"
          >
            <span class="text-muted text-sm">
              {{ t("amendment.detail.transactedIn") }}
            </span>
            <UButton
              v-for="id in transactedInIds"
              :key="id"
              size="xs"
              color="secondary"
              variant="soft"
              icon="i-lucide-git-merge"
              :label="labelOf(id)"
              @click="emit('select', id)"
            />
          </div>
          <!-- Transactionals over this one: what its main author answered. -->
          <template v-if="transactionalsAnswered.length > 0">
            <p class="text-muted text-sm">
              {{ t("amendment.detail.transactionalsOver") }}
            </p>
            <TransactionalAuthorAnswer
              v-for="item in transactionalsAnswered"
              :key="item.id"
              :transactional="item"
              :source="amendment"
              :primary="false"
              :amendments-url="amendmentsUrl"
              :actor-member-id="member?.id ?? null"
              :label-of="labelOf"
              :status-of="statusOf"
              :amendment-of="amendmentOf"
              @updated="emit('updated', $event)"
              @conflict="emit('changed')"
              @select="emit('select', $event)"
            />
          </template>
        </section>

        <!-- The parties of a transactional, once nobody here answers. -->
        <AmendmentAcceptances
          v-if="amendment.kind === 'transactional' && !acceptancesTurn"
          :amendment="amendment"
          :url="url"
          :actor-member-id="member?.id ?? null"
          :sources="sources"
          :label-of="labelOf"
          @updated="emit('updated', $event)"
          @conflict="emit('changed')"
        />

        <AmendmentRelations
          v-if="showRelations"
          :amendment="amendment"
          :relations="relations"
          :candidates="candidates"
          :label-of="labelOf"
          :amendments-url="amendmentsUrl"
          :can-manage="canManageRelations"
          @changed="emit('changed')"
          @select="emit('select', $event)"
        />

        <section class="flex flex-col gap-2">
          <h3 class="text-highlighted text-sm font-semibold">
            {{ t("amendment.detail.history") }}
          </h3>
          <AmendmentHistory
            :url="url"
            :version="historyVersion"
            :decisions-url="decisionsUrl"
            :members="historyMembers"
            :label-of="historyLabelOf"
          />
        </section>
      </div>
    </div>

    <footer
      v-if="
        amendment.can.edit ||
        amendment.can.submit ||
        amendment.can.withdraw ||
        transactable
      "
      class="border-default bg-default sticky bottom-0 -mx-1 flex flex-col gap-2 border-t px-1 pt-3 pb-1"
    >
      <UAlert
        v-if="showSubmit && lateOnSend"
        color="warning"
        variant="subtle"
        icon="i-lucide-clock-alert"
        :title="t('amendment.composer.lateTitle')"
        :description="t('amendment.composer.lateWarning')"
      />

      <div
        v-if="confirming"
        class="flex flex-wrap items-center gap-2"
        role="group"
      >
        <span class="text-sm">
          {{
            confirming === "delete"
              ? t("amendment.detail.deleteConfirm")
              : t("amendment.detail.withdrawConfirm")
          }}
        </span>
        <UButton
          color="error"
          size="sm"
          :loading="busy === confirming"
          :label="
            confirming === 'delete'
              ? t('amendment.actions.delete')
              : t('amendment.actions.withdraw')
          "
          @click="confirming === 'delete' ? remove() : withdraw()"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :disabled="busy !== null"
          :label="t('amendment.actions.cancel')"
          @click="confirming = null"
        />
      </div>

      <div v-else class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="showEdit"
          icon="i-lucide-pencil"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('amendment.actions.edit')"
          :disabled="busy !== null"
          @click="emit('edit', amendment)"
        />
        <UButton
          v-if="amendment.can.withdraw"
          icon="i-lucide-undo-2"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('amendment.actions.withdraw')"
          :disabled="busy !== null"
          @click="confirming = 'withdraw'"
        />
        <UButton
          v-if="transactable"
          icon="i-lucide-git-merge"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t('amendment.detail.transact')"
          :disabled="busy !== null"
          @click="emit('transact', [amendment.id])"
        />
        <UButton
          v-if="amendment.can.edit"
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          size="sm"
          :label="t('amendment.actions.delete')"
          :disabled="busy !== null"
          @click="confirming = 'delete'"
        />
        <UButton
          v-if="showSubmit"
          icon="i-lucide-send"
          size="sm"
          class="ms-auto"
          :loading="busy === 'submit'"
          :disabled="busy !== null"
          :label="t('amendment.actions.submit')"
          @click="submit"
        />
      </div>
    </footer>
  </article>
</template>
