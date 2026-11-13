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
  amendmentStatusLine,
  isAmendmentPrivate,
} from "~/composables/amendment/workspace";

/**
 * One amendment in the workspace list, kept to what tells them apart:
 * label (its code already names the main author, so no member badge
 * repeats it; how many more present it), "De forma" or a totality kind
 * when it is not the usual content kind, one status only when it says
 * something (where it stands with the Secretaría while it is a draft or
 * waits for it, the outcome once decided: amendmentStatusLine; a presented,
 * public amendment, the usual case, shows none) and one line of
 * justification.
 * A presented transactional says instead, in one line, what it waits for
 * (the main authors still to answer, or who rejected it) or which
 * amendments it replaced.
 *
 * Before the label, whether the account has read it (ReadMark).
 *
 * Only what asks the viewer to act stays besides that: the Secretaría's
 * note when it asked for a correction, that a late amendment waits for the
 * assembly's decision, and that it came in late. Kind, change typology,
 * admission, the main presenter's answer, relations and transactional links
 * are in the detail. The content kind and the transactional one (its code
 * is "T n") show no kind.
 *
 * An amendment that is not public yet has a dashed border and says who can
 * see it. The whole card is one button that selects the amendment
 * (`data-amendment-card` lets the page give it focus back).
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** "12 · CEUM 4", or the draft label. */
    label: string;
    labelOf: (id: string) => string;
    selected?: boolean;
    /**
     * Status of another amendment of the document (the workspace list), so
     * a transactional can tell whether it replaced the ones it combines.
     */
    statusOf?: (id: string) => AmendmentStatus | undefined;
  }>(),
  {
    selected: false,
    statusOf: undefined,
  },
);

const emit = defineEmits<{ select: [id: string] }>();

const { t } = useI18n();
const { member } = useMe();

/**
 * A presented, undecided transactional out of the Secretaría's hands: its
 * progress line is its status (the same rule as the review panel), also
 * once a main author rejected it ("Rechazada por CEUM").
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
/** Main author first; the rest are counted. */
const authors = computed(() => amendmentAuthorsInOrder(props.amendment));
const lateState = computed(() => amendmentLateState(props.amendment));
const isPrivate = computed(() => isAmendmentPrivate(props.amendment));
/** One status: the review badge while it says more, else the status. */
const statusLine = computed(() => amendmentStatusLine(props.amendment));
const showStatus = computed(
  () =>
    !hasProgress.value &&
    statusLine.value.type === "status" &&
    props.amendment.status !== "submitted",
);
/** "De forma", or a totality kind: what the code does not say. */
const kindLabel = computed(() =>
  props.amendment.kind === "partial" || props.amendment.kind === "transactional"
    ? null
    : t(`amendment.kinds.${props.amendment.kind}`),
);
const correctionNote = computed(() =>
  props.amendment.reviewState === "correction_requested"
    ? props.amendment.correctionNote
    : null,
);

/**
 * Whether the account has read it: a dot while it is left to read (never
 * on one already decided, which nobody has to read any more), "Con
 * cambios", or a tick.
 */
const marks = useReadMarks();
const readMark = computed(() => {
  const mark = marks.amendment(props.amendment.id);
  return mark && (mark.open || mark.state === "read") ? mark : null;
});
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
      <ReadMark
        kind="amendment"
        :state="readMark?.state"
        :own="readMark?.own"
      />
      <span class="text-highlighted font-semibold tabular-nums">
        {{ label }}
      </span>
      <UBadge
        v-if="kindLabel"
        color="neutral"
        variant="outline"
        size="xs"
        :label="kindLabel"
      />
      <span v-if="authors.others.length > 0" class="text-muted text-xs">
        {{
          t(
            "amendment.card.moreAuthors",
            { count: authors.others.length },
            authors.others.length,
          )
        }}
      </span>
      <span v-if="showStatus" class="ms-auto flex items-center">
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
      :show-badge="!hasProgress"
      class="mt-2"
    />

    <!-- Late: waiting for the assembly's decision, or just out of time. -->
    <span v-if="lateState" class="mt-2 flex items-start gap-1.5 text-sm">
      <UIcon
        name="i-lucide-clock-alert"
        class="text-warning mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="text-default">
        <span class="font-medium">
          {{
            lateState === "late" && amendment.admission === "admitted"
              ? t("amendment.lateAdmitted")
              : t("amendment.late")
          }}
        </span>
        <template v-if="lateState === 'awaiting_decision'">
          · {{ t("amendment.lateState.awaiting") }}
        </template>
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

    <span
      v-if="amendment.justification"
      class="text-muted mt-2 line-clamp-1 block text-sm"
    >
      {{ amendment.justification }}
    </span>
  </button>
</template>
