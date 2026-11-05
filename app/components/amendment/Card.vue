<script setup lang="ts">
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  transactionalProgressMessage,
  transactionalProgressOf,
} from "~/composables/amendment/transactional";
import {
  amendmentAuthorsInOrder,
  amendmentLateState,
  amendmentReviewView,
  isAmendmentPrivate,
  showAmendmentAdmission,
  type AmendmentRelationView,
} from "~/composables/amendment/workspace";

/**
 * One amendment in the workspace list: label, presenting members (the main
 * author first, marked when there are several), one status (where it
 * stands with the Secretaría while it is a draft or waits for it, the
 * outcome otherwise), the Secretaría's note when it asked for a correction,
 * the kind when it is not the usual partial one, change typology, admission
 * and the main presenter's answer, the late mark, relations and
 * transactional links. A presented transactional says instead, in one line,
 * what it waits for (the main authors still to answer, or who rejected it)
 * or which amendments it replaced; while the Secretaría has it, the usual
 * review badge stays (as in the detail), so the Secretaría still finds it
 * "Por revisar". A late amendment the assembly still has to decide on says
 * so in a line of its own. An amendment that is not public yet has a dashed
 * border and says who can see it. The whole card is one button that
 * selects the amendment (`data-amendment-card` lets the page give it focus
 * back).
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** "12 · CEUM 4", or the draft label. */
    label: string;
    labelOf: (id: string) => string;
    relations?: AmendmentRelationView[];
    selected?: boolean;
    /** Also say "Publicada" ("Mis enmiendas"), not only the private states. */
    showPublished?: boolean;
    /**
     * Status of another amendment of the document (the workspace list), so
     * a transactional can tell whether it replaced the ones it combines.
     */
    statusOf?: (id: string) => AmendmentStatus | undefined;
  }>(),
  {
    relations: () => [],
    selected: false,
    showPublished: false,
    statusOf: undefined,
  },
);

const emit = defineEmits<{ select: [id: string] }>();

const { t } = useI18n();
const { member } = useMe();

/**
 * A presented, undecided transactional out of the Secretaría's hands: its
 * progress line replaces the badges (the same rule as the review panel).
 */
const progress = computed(() =>
  transactionalProgressOf(
    props.amendment,
    member.value?.id ?? null,
    props.statusOf,
  ),
);
const hasProgress = computed(
  () =>
    progress.value !== null &&
    transactionalProgressMessage(progress.value, "long") !== null,
);
/** Main author first; marked only when there are several. */
const authors = computed(() => amendmentAuthorsInOrder(props.amendment));
const lateState = computed(() => amendmentLateState(props.amendment));
/** Late and waiting for the assembly: its own line, no extra badges. */
const awaitingDecision = computed(
  () => lateState.value === "awaiting_decision",
);
const showAdmission = computed(
  () =>
    props.amendment.status === "submitted" &&
    !awaitingDecision.value &&
    showAmendmentAdmission(props.amendment),
);
const isPrivate = computed(() => isAmendmentPrivate(props.amendment));
/**
 * While it is a draft or waits for the Secretaría, the review badge
 * ("Sin enviar", "En revisión") says it better than "Borrador" or
 * "Presentada": show one, not both. A transactional's progress line does
 * the same, also once a main author rejected it ("Rechazada por CEUM").
 */
const showStatus = computed(() => {
  if (hasProgress.value) return false;
  if (
    props.amendment.status !== "draft" &&
    props.amendment.status !== "submitted"
  ) {
    return true;
  }
  const review = amendmentReviewView(props.amendment);
  const reviewShown =
    review !== null && (props.showPublished || review.key !== "published");
  return !reviewShown;
});
/** "Parcial" is the usual kind: only the others are worth a badge. */
const showKind = computed(() => props.amendment.kind !== "partial");
const correctionNote = computed(() =>
  props.amendment.reviewState === "correction_requested"
    ? props.amendment.correctionNote
    : null,
);
const showPosition = computed(
  () =>
    props.amendment.position !== null &&
    props.amendment.position.position !== "pending",
);

/** The progress line already names the amendments it replaced. */
const sources = computed(() =>
  progress.value?.stage === "replaced"
    ? ""
    : props.amendment.sourceIds.map((id) => props.labelOf(id)).join(", "),
);
const transactedIn = computed(() =>
  props.amendment.transactionalIds.map((id) => props.labelOf(id)).join(", "),
);
const showTags = computed(
  () =>
    showKind.value ||
    props.amendment.changeKinds.length > 0 ||
    showAdmission.value ||
    showPosition.value ||
    lateState.value === "late" ||
    props.amendment.globalReplace !== null,
);

function relationLabel(view: AmendmentRelationView): string {
  const key =
    view.direction === "from"
      ? `amendment.relations.kinds.${view.relation.kind}`
      : `amendment.relations.inverse.${view.relation.kind}`;
  return `${t(key)} ${props.labelOf(view.otherId)}`;
}
</script>

<template>
  <button
    type="button"
    class="group w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
    :class="[
      selected
        ? 'border-primary bg-primary/5 ring-primary ring-1'
        : isPrivate
          ? 'border-accented bg-elevated/30 hover:bg-elevated/60'
          : 'border-default bg-default hover:bg-elevated/60',
      isPrivate ? 'border-dashed' : '',
    ]"
    :aria-current="selected ? 'true' : undefined"
    :data-amendment-card="amendment.id"
    @click="emit('select', amendment.id)"
  >
    <span class="flex flex-wrap items-center gap-1.5">
      <span class="text-highlighted font-semibold tabular-nums">
        {{ label }}
      </span>
      <template v-if="authors.main">
        <CommonMemberBadge :member="authors.main" size="xs" />
        <span v-if="authors.marked" class="text-dimmed text-xs">
          {{ t("amendment.card.mainAuthor") }}
        </span>
      </template>
      <CommonMemberBadge
        v-for="author in authors.others"
        :key="author.id"
        :member="author"
        size="xs"
      />
      <span v-if="showStatus" class="ms-auto flex flex-wrap items-center gap-1">
        <CommonStatusBadge
          kind="amendment"
          :value="amendment.status"
          size="xs"
        />
      </span>
    </span>

    <TransactionalProgress
      v-if="hasProgress"
      :amendment="amendment"
      :label-of="labelOf"
      :status-of="statusOf"
      class="mt-2"
    />
    <AmendmentReviewBadge
      :amendment="amendment"
      :show-published="showPublished"
      :show-badge="!hasProgress"
      class="mt-2"
    />

    <!-- Late, validated, and not admitted yet: the assembly decides. -->
    <span v-if="awaitingDecision" class="mt-2 flex items-start gap-1.5 text-sm">
      <UIcon
        name="i-lucide-clock-alert"
        class="text-warning mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="text-default">
        <span class="font-medium">{{ t("amendment.late") }}</span>
        · {{ t("amendment.lateState.awaiting") }}
      </span>
    </span>

    <!-- What the Secretaría asked to fix; the detail has the action. -->
    <span v-if="correctionNote" class="mt-2 flex items-start gap-1.5 text-sm">
      <UIcon
        name="i-lucide-message-square-warning"
        class="text-warning mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="text-default line-clamp-2">
        <span class="font-medium">
          {{ t("amendment.review.noteFromSecretaria") }}:
        </span>
        {{ correctionNote }}
      </span>
    </span>

    <span v-if="showTags" class="mt-2 flex flex-wrap items-center gap-1">
      <UBadge
        v-if="showKind"
        color="neutral"
        variant="outline"
        size="xs"
        :label="t(`amendment.kinds.${amendment.kind}`)"
      />
      <UBadge
        v-for="change in amendment.changeKinds"
        :key="change"
        color="neutral"
        variant="soft"
        size="xs"
        :label="t(`amendment.changeKinds.${change}`)"
      />
      <CommonStatusBadge
        v-if="showAdmission"
        kind="admission"
        :value="amendment.admission"
        size="xs"
      />
      <CommonStatusBadge
        v-if="showPosition && amendment.position"
        kind="position"
        :value="amendment.position.position"
        size="xs"
      />
      <UBadge
        v-if="lateState === 'late'"
        color="warning"
        variant="subtle"
        size="xs"
        icon="i-lucide-clock-alert"
        :label="t('amendment.late')"
      />
      <UBadge
        v-if="amendment.globalReplace"
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-replace-all"
        :label="t('amendment.card.global')"
      />
    </span>

    <span
      v-if="amendment.justification"
      class="text-muted mt-2 line-clamp-2 block text-sm"
    >
      {{ amendment.justification }}
    </span>

    <span
      v-if="relations.length > 0 || sources || transactedIn"
      class="mt-2 flex flex-wrap gap-1"
    >
      <UBadge
        v-if="sources"
        color="secondary"
        variant="soft"
        size="xs"
        icon="i-lucide-git-merge"
        :label="t('amendment.card.sources', { list: sources })"
      />
      <UBadge
        v-if="transactedIn"
        color="secondary"
        variant="soft"
        size="xs"
        icon="i-lucide-git-merge"
        :label="t('amendment.card.transactedIn', { list: transactedIn })"
      />
      <UBadge
        v-for="view in relations"
        :key="view.relation.id"
        :color="view.relation.kind === 'incompatible' ? 'error' : 'info'"
        variant="soft"
        size="xs"
        icon="i-lucide-link-2"
        :label="relationLabel(view)"
      />
    </span>
  </button>
</template>
