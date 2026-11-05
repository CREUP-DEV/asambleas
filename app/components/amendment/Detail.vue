<script setup lang="ts">
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  DocumentDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { blockLabels } from "~~/shared/utils/content/render";
import { touchedBlockIds } from "~~/shared/utils/content/ops";
import {
  transactionalAuthorTurn,
  transactionalClosure,
  transactionalGroupSources,
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
  showAmendmentAdmission,
  type AmendmentOverlap,
  type AmendmentRelationView,
} from "~/composables/amendment/workspace";

/**
 * Everything about one amendment: where it stands with the Secretaría (and
 * the Secretaría's validation actions), its changes over the base (with
 * context), justification, authors (the main author first), outcome,
 * overlaps, the main presenter's answer, transactional parties, relations,
 * the history (folded), and the author actions (edit, send to the
 * Secretaría, delete a draft; withdraw while undecided).
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
 * note says it. A draft sent back for correction has one way forward,
 * "Corregir y volver a enviar" in the review panel: the composer shows the
 * note and sends it, so the footer offers no direct send.
 *
 * Whoever can propose a transactional finds it as a secondary action: in
 * the footer's "Más" menu for this amendment, and next to the amendments
 * that touch the same passage to combine them (`transact`).
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
    /** Show the close button (off inside a slideover, which has its own). */
    closable?: boolean;
    /** GET .../decisions of the assembly, for admission votes in the history. */
    decisionsUrl?: string;
    /** The viewer may propose a transactional on this document. */
    canTransact?: boolean;
  }>(),
  {
    overlaps: () => [],
    closable: true,
    decisionsUrl: undefined,
    canTransact: false,
  },
);

const emit = defineEmits<{
  close: [];
  select: [id: string];
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
const heading = useTemplateRef<HTMLElement>("heading");
const { member } = useMe();

const url = computed(() => `${props.amendmentsUrl}/${props.amendment.id}`);
const label = computed(() => props.labelOf(props.amendment.id));

const busy = ref<"submit" | "withdraw" | "delete" | null>(null);
const historyOpen = ref(false);
const confirming = ref<"withdraw" | "delete" | null>(null);
const reasons = ref<string[]>([]);

watch(
  () => props.amendment.id,
  () => {
    confirming.value = null;
    reasons.value = [];
    historyOpen.value = false;
  },
);

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
const showPosition = computed(
  () => props.amendment.position !== null || props.amendment.can.position,
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

const moreItems = computed(() => {
  const items: {
    label: string;
    icon: string;
    color?: "error";
    onSelect: () => void;
  }[] = [];
  if (transactable.value) {
    items.push({
      label: t("amendment.detail.transact"),
      icon: "i-lucide-git-merge",
      onSelect: () => emit("transact", [props.amendment.id]),
    });
  }
  if (props.amendment.can.edit) {
    items.push({
      label: t("amendment.actions.delete"),
      icon: "i-lucide-trash-2",
      color: "error",
      onSelect: () => {
        confirming.value = "delete";
      },
    });
  }
  return items;
});
/** Late and validated: the review panel says the assembly has to decide. */
const awaitingDecision = computed(
  () => amendmentLateState(props.amendment) === "awaiting_decision",
);

const where = computed(() => {
  const ids = touchedBlockIds(props.amendment.ops);
  if (ids.length === 0) return null;
  const labels = blockLabels(props.base);
  const first = labels.get(ids[0]!);
  if (!first) return null;
  const paragraph =
    first.paragraph > 0
      ? t("amendment.detail.paragraph", { n: first.paragraph })
      : null;
  return [first.heading, paragraph].filter(Boolean).join(" · ") || null;
});

/** Main author first; marked only when there are several. */
const authors = computed(() => amendmentAuthorsInOrder(props.amendment));
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
  <article class="flex flex-col gap-5" :aria-labelledby="headingId">
    <header class="flex flex-col gap-2">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
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
        <UButton
          v-if="closable"
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('amendment.detail.close')"
          @click="emit('close')"
        />
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <!-- Closed by a main author's rejection: the review panel says so. -->
        <CommonStatusBadge
          v-if="!rejectedByAuthors"
          kind="amendment"
          :value="amendment.status"
        />
        <CommonStatusBadge
          v-if="!awaitingDecision && showAmendmentAdmission(amendment)"
          kind="admission"
          :value="amendment.admission"
        />
        <!-- Waiting for the assembly, the review panel says it is late. -->
        <UBadge
          v-if="amendment.late && !awaitingDecision"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock-alert"
          :label="t('amendment.late')"
        />
        <UBadge
          v-if="showKind"
          color="neutral"
          variant="outline"
          :label="t(`amendment.kinds.${amendment.kind}`)"
        />
        <UBadge
          v-for="change in amendment.changeKinds"
          :key="change"
          color="neutral"
          variant="soft"
          :label="t(`amendment.changeKinds.${change}`)"
        />
      </div>
    </header>

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

    <section class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.changes") }}
      </h3>
      <p v-if="amendment.globalReplace" class="text-sm">
        <UIcon
          name="i-lucide-replace-all"
          class="text-muted me-1 size-4 align-text-bottom"
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
          :focus="amendment.id"
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
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.justification") }}
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
        {{ t("amendment.detail.approvedByPresenter") }}
      </p>
      <p
        v-else-if="amendment.status === 'approved' && amendment.approvalMethod"
        class="text-sm"
      >
        {{
          t("amendment.detail.approvedBy", {
            method: t(`amendment.approvalMethods.${amendment.approvalMethod}`),
          })
        }}
      </p>
      <!-- Closed by a main author's rejection: who said no. -->
      <p v-if="rejectedByAuthors && rejectedBy" class="text-sm">
        {{ t("amendment.detail.rejectedByAuthors", { members: rejectedBy }) }}
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

    <section v-if="overlaps.length > 0" class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.detail.overlaps") }}
      </h3>
      <ul class="flex flex-wrap gap-2">
        <li v-for="overlap in overlaps" :key="overlap.id">
          <UButton
            size="xs"
            :color="overlap.kind === 'same_position' ? 'neutral' : 'warning'"
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
        transactionalsOver.length > 0
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
      <!-- Transactionals over this one: its main author's answer. -->
      <template v-if="transactionalsOver.length > 0">
        <p class="text-muted text-sm">
          {{ t("amendment.detail.transactionalsOver") }}
        </p>
        <TransactionalAuthorAnswer
          v-for="item in transactionalsOver"
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
      </template>
    </section>

    <AmendmentAcceptances
      v-if="amendment.kind === 'transactional'"
      :amendment="amendment"
      :url="url"
      :actor-member-id="member?.id ?? null"
      :sources="sources"
      :label-of="labelOf"
      @updated="emit('updated', $event)"
      @conflict="emit('changed')"
    />

    <AmendmentPositionPanel
      v-if="showPosition"
      :amendment="amendment"
      :url="url"
      :document="document"
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

    <UCollapsible v-model:open="historyOpen">
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        class="px-0"
        :icon="historyOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="
          historyOpen
            ? t('amendment.detail.hideHistory')
            : t('amendment.detail.showHistory')
        "
      />
      <template #content>
        <AmendmentHistory
          class="mt-2"
          :url="url"
          :version="historyVersion"
          :decisions-url="decisionsUrl"
          :members="historyMembers"
          :label-of="historyLabelOf"
        />
      </template>
    </UCollapsible>

    <footer
      v-if="
        amendment.can.edit ||
        amendment.can.submit ||
        amendment.can.withdraw ||
        moreItems.length > 0
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
        <UDropdownMenu
          v-if="moreItems.length > 0"
          :items="moreItems"
          :content="{ align: 'start', side: 'top' }"
        >
          <UButton
            icon="i-lucide-ellipsis"
            color="neutral"
            variant="ghost"
            size="sm"
            :label="t('amendment.actions.more')"
            :disabled="busy !== null"
          />
        </UDropdownMenu>
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
