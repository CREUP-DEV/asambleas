<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AmendmentDto } from "~~/shared/types/api";
import { PROPONENT_POSITIONS } from "~~/shared/constants/domain";
import {
  SESSION_REOPENABLE,
  isSessionPublishable,
  sessionMissingAcceptances,
} from "~/composables/session/sessionModel";
import { useFinalVoteReasonText } from "~/composables/session/useFinalVoteReasonText";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * The amendment under debate, in large type: who presents it, where it
 * stands as a sentence that says what comes next, its change over the base
 * text, the position of whoever presents the document and, for a
 * transactional, the answer of every party. Below, the actions that fit
 * where it stands, the one that matters most first:
 *
 * - open: approve by assent or vote (whichever the proponent's position
 *   suggests leads), plus transactional, withdrawal and lapse; the rest in
 *   "Más". On a phone only assent, vote, "Más" and "Siguiente" stay in the
 *   row: transactional, withdrawal and lapse move to the top of "Más";
 * - late, not admitted yet: only the decision to treat it;
 * - decided: "Siguiente", or the final vote when nothing is left; when
 *   neither is possible yet, why the final vote waits and the one next
 *   step (the assembly's decision on late amendments, or back to the
 *   document).
 *
 * Every amendment under debate is public: the projection shows it.
 * NowPanel announces changes to screen readers.
 */
const props = defineProps<{ amendment: AmendmentDto }>();

const session = useSessionConsoleContext();
const { t } = useI18n();

const id = computed(() => props.amendment.id);
const code = computed(() => session.label(id.value));
const stage = computed(() => session.stageOf(props.amendment));
const busy = computed(() => Boolean(session.busy.value[id.value]));
const missing = computed(() => sessionMissingAcceptances(props.amendment));
const decidable = computed(
  () => stage.value === "open" || stage.value === "acceptances",
);
const decided = computed(() => props.amendment.status !== "submitted");
const next = computed(() => session.nextAmendment.value);
/** Wide enough for every decision in the row; on a phone some go to "Más". */
const wide = useMediaQuery("(min-width: 640px)");

/**
 * Assent leads when whoever presents the document accepts the amendment
 * and this assembly does not vote accepted amendments anyway.
 */
const assentFirst = computed(
  () =>
    props.amendment.position?.position === "accept" &&
    session.settings.value.acceptedAmendments !== "vote",
);

const statusText = computed(() => {
  const value = stage.value;
  if (value === "acceptances") {
    return t(
      "session.now.stage.acceptances",
      { count: missing.value },
      missing.value,
    );
  }
  if (value === "open") {
    return assentFirst.value
      ? t("session.now.stage.openAccepted")
      : t("session.now.stage.open");
  }
  if (value === "transacted") {
    return t("session.now.stage.transacted", {
      codes: props.amendment.transactionalIds.map(session.label).join(", "),
    });
  }
  return t(`session.now.stage.${value}`);
});

const outcomeDetail = computed(() => {
  const parts: string[] = [];
  if (props.amendment.approvalMethod) {
    parts.push(
      t(`session.enums.approvalMethod.${props.amendment.approvalMethod}`),
    );
  }
  const vote = props.amendment.outcomeVote;
  if (vote) {
    parts.push(
      t("session.card.voteCounts", {
        inFavor: vote.inFavor,
        against: vote.against,
        abstentions: vote.abstentions,
      }),
    );
  }
  return parts.join(" · ");
});

const STAGE_TONE: Record<string, string> = {
  open: "border-info/40 bg-info/5",
  acceptances: "border-warning/50 bg-warning/5",
  late: "border-warning/50 bg-warning/5",
  approved: "border-success/50 bg-success/10",
  rejected: "border-error/50 bg-error/10",
};

const showJustification = ref(false);
watch(id, () => {
  showJustification.value = false;
});

// Actions ------------------------------------------------------------------------

const POSITION_ICONS = {
  pending: "i-lucide-circle-dashed",
  accept: "i-lucide-thumbs-up",
  reject: "i-lucide-thumbs-down",
  transact: "i-lucide-git-merge",
} as const;

const finalVoteReady = computed(
  () =>
    !next.value &&
    session.finalVoteReasons.value.length === 0 &&
    !session.document.value?.finalVote &&
    Boolean(session.document.value?.can.moderate),
);

/** Decided, with nothing to debate next and no final vote to open yet. */
const stuck = computed(
  () => decided.value && !next.value && !finalVoteReady.value,
);
const reasonText = useFinalVoteReasonText(session.label);
/** Why the final vote waits, when nothing else can be debated now. */
const waitingReasons = computed(() =>
  stuck.value && !session.document.value?.finalVote
    ? session.finalVoteReasons.value
        // A text that is not voted has no final vote to wait for.
        .filter(
          (reason) =>
            reason.key !== "amendmentsLoading" && reason.key !== "notVoted",
        )
        .map(reasonText)
    : [],
);
const lateIds = computed(() =>
  session.queue.value.pending.map((amendment) => amendment.id),
);

const moreItems = computed<DropdownMenuItem[][]>(() => {
  const amendment = props.amendment;
  const groups: DropdownMenuItem[][] = [];
  if (decidable.value && !wide.value) {
    // On a phone the row keeps assent and vote; the other decisions lead
    // "Más".
    groups.push([
      {
        label: t("session.actions.transact"),
        icon: "i-lucide-git-merge",
        onSelect: () => session.openComposer([amendment.id]),
      },
      {
        label: t("session.actions.withdraw"),
        icon: "i-lucide-undo-2",
        onSelect: () => void session.withdraw(amendment),
      },
      {
        label: t("session.actions.lapse"),
        icon: "i-lucide-circle-slash",
        onSelect: () => void session.lapse(amendment),
      },
    ]);
  }
  if (decidable.value) {
    const decide: DropdownMenuItem[] = [
      {
        label: t("session.actions.proponent"),
        icon: "i-lucide-user-check",
        disabled: missing.value > 0,
        onSelect: () => void session.approve(amendment, "proponent"),
      },
      {
        label: t("session.actions.formal"),
        icon: "i-lucide-spell-check",
        disabled: missing.value > 0,
        onSelect: () => void session.approve(amendment, "formal"),
      },
    ];
    if (amendment.can.position) {
      const current = amendment.position?.position ?? "pending";
      decide.push({
        label: t("amendment.position.title"),
        icon: "i-lucide-user-round-check",
        children: PROPONENT_POSITIONS.map((position) => ({
          type: "checkbox" as const,
          label: t(`amendment.position.options.${position}`),
          icon: POSITION_ICONS[position],
          checked: current === position,
          onSelect: () => {
            if (current !== position) {
              void session.setPosition(amendment, position);
            }
          },
        })),
      });
    }
    groups.push(decide);
    groups.push([
      {
        label: t("session.actions.inadmit"),
        icon: "i-lucide-octagon-x",
        color: "error",
        onSelect: () => session.openAdmission([amendment.id], "inadmissible"),
      },
      {
        label: t("session.actions.relate"),
        icon: "i-lucide-link",
        onSelect: () => session.openRelation(amendment),
      },
    ]);
  }
  if (decided.value && SESSION_REOPENABLE.includes(amendment.status)) {
    groups.push([
      {
        label: t("session.actions.reopen"),
        icon: "i-lucide-rotate-ccw",
        onSelect: () => void session.reopen(amendment),
      },
    ]);
  }
  const last: DropdownMenuItem[] = [];
  if (isSessionPublishable(amendment)) {
    last.push({
      label: t("session.actions.publish"),
      icon: "i-lucide-eye",
      onSelect: () => void session.publishAmendments([amendment.id]),
    });
  }
  last.push({
    label: t("session.actions.undebate"),
    icon: "i-lucide-radio-tower",
    onSelect: () => void session.clearDebatedAmendment(),
  });
  groups.push(last);
  return groups;
});
</script>

<template>
  <div class="space-y-4">
    <!-- Who and what, in large type. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p class="text-highlighted text-3xl font-bold tabular-nums sm:text-4xl">
        {{ t("session.card.label", { code }) }}
      </p>
      <span class="inline-flex flex-wrap items-center gap-1.5">
        <CommonMemberBadge
          v-for="author in amendment.authors"
          :key="author.id"
          :member="author"
          size="md"
        />
      </span>
      <span class="text-muted text-sm">
        {{ t(`session.enums.amendmentKind.${amendment.kind}`) }}
      </span>
    </div>

    <!-- Where it stands, and what comes next. -->
    <div
      class="rounded-lg border px-3 py-2"
      :class="STAGE_TONE[stage] ?? 'border-default bg-elevated/40'"
    >
      <p class="text-highlighted font-medium">{{ statusText }}</p>
      <p v-if="outcomeDetail" class="text-default text-sm tabular-nums">
        {{ outcomeDetail }}
      </p>
      <p v-if="amendment.outcomeNote" class="text-muted text-sm italic">
        {{ amendment.outcomeNote }}
      </p>
    </div>

    <p
      v-if="amendment.position && !decided"
      class="text-default flex flex-wrap items-center gap-1.5 text-sm"
    >
      <span class="text-muted">{{ t("session.now.position") }}</span>
      <CommonStatusBadge
        kind="position"
        :value="amendment.position.position"
        size="sm"
      />
      <span v-if="amendment.position.comment" class="text-muted min-w-0 italic">
        {{ amendment.position.comment }}
      </span>
    </p>

    <ContentAmendmentDiff
      :id="amendment.id"
      :base="session.base.value"
      :ops="amendment.ops"
      :context="1"
      class="text-base sm:text-lg"
    />

    <div v-if="amendment.justification">
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        class="px-0"
        :trailing-icon="
          showJustification ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
        "
        :label="
          showJustification
            ? t('session.now.hideJustification')
            : t('session.now.showJustification')
        "
        :aria-expanded="showJustification"
        aria-controls="session-now-justification"
        @click="showJustification = !showJustification"
      />
      <p
        v-show="showJustification"
        id="session-now-justification"
        class="content-font text-default mt-1 text-sm whitespace-pre-line"
      >
        {{ amendment.justification }}
      </p>
    </div>

    <SessionAcceptanceList
      v-if="amendment.kind === 'transactional' && !decided"
      :amendment="amendment"
    />

    <!-- Nothing left to debate now: why the final vote still waits. -->
    <div
      v-if="stuck && (lateIds.length > 0 || waitingReasons.length > 0)"
      class="space-y-1 text-sm"
    >
      <p v-if="lateIds.length > 0" class="text-default font-medium">
        {{ t("session.now.late", { count: lateIds.length }, lateIds.length) }}
      </p>
      <template v-if="waitingReasons.length > 0">
        <p class="text-default font-medium">
          {{ t("session.now.document.waiting") }}
        </p>
        <ul class="text-muted list-disc space-y-1 ps-5">
          <li v-for="reason in waitingReasons" :key="reason">{{ reason }}</li>
        </ul>
      </template>
    </div>

    <!-- Actions that fit where it stands. -->
    <div class="flex flex-wrap items-center gap-2">
      <template v-if="decidable">
        <UTooltip
          :text="
            missing > 0
              ? t('session.card.needsAcceptances')
              : t('session.now.assentHint')
          "
          :kbds="['a']"
        >
          <UButton
            size="lg"
            color="success"
            :variant="assentFirst ? 'solid' : 'outline'"
            icon="i-lucide-check"
            :label="t('session.now.assent')"
            :loading="busy"
            :disabled="busy || missing > 0"
            @click="session.approve(amendment, 'assent')"
          />
        </UTooltip>
        <UTooltip :text="t('session.actions.voteHint')" :kbds="['v']">
          <UButton
            size="lg"
            color="primary"
            :variant="assentFirst ? 'outline' : 'solid'"
            icon="i-lucide-gavel"
            :label="t('session.actions.vote')"
            :disabled="busy || missing > 0"
            @click="session.openVote(amendment)"
          />
        </UTooltip>
        <template v-if="wide">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-git-merge"
            :label="t('session.actions.transact')"
            :disabled="busy"
            @click="session.openComposer([amendment.id])"
          />
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-undo-2"
            :label="t('session.actions.withdraw')"
            :disabled="busy"
            @click="session.withdraw(amendment)"
          />
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-circle-slash"
            :label="t('session.actions.lapse')"
            :disabled="busy"
            @click="session.lapse(amendment)"
          />
        </template>
      </template>

      <UButton
        v-else-if="stage === 'late'"
        size="lg"
        color="warning"
        icon="i-lucide-gavel"
        :label="t('session.actions.decideTreat')"
        :disabled="busy"
        @click="session.openAdmission([amendment.id], 'admitted')"
      />

      <template v-else-if="decided">
        <UButton
          v-if="next"
          size="lg"
          trailing-icon="i-lucide-arrow-right"
          :label="t('session.now.next', { code: session.label(next.id) })"
          :disabled="Boolean(session.busy.value.live)"
          @click="session.debateNext()"
        />
        <UButton
          v-else-if="finalVoteReady"
          size="lg"
          icon="i-lucide-gavel"
          :label="t('session.finalVote.open')"
          @click="session.finalVoteDialog.open = true"
        />
        <!-- Nothing to debate next: the late ones first, else the document. -->
        <UButton
          v-else-if="lateIds.length > 0"
          size="lg"
          color="warning"
          icon="i-lucide-gavel"
          :label="
            t(
              'session.queue.lateDecide',
              { count: lateIds.length },
              lateIds.length,
            )
          "
          :disabled="Boolean(session.busy.value.admission)"
          @click="session.openAdmission(lateIds, 'admitted')"
        />
        <UButton
          v-else
          size="lg"
          icon="i-lucide-file-text"
          :label="t('session.now.backToDocument')"
          :loading="Boolean(session.busy.value.live)"
          @click="session.clearDebatedAmendment()"
        />
      </template>

      <UDropdownMenu :items="moreItems" :content="{ align: 'end' }">
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-ellipsis"
          :label="t('session.now.more')"
          :disabled="busy"
        />
      </UDropdownMenu>

      <UButton
        v-if="!decided && next"
        class="ms-auto"
        color="neutral"
        variant="outline"
        trailing-icon="i-lucide-arrow-right"
        :label="t('session.now.next', { code: session.label(next.id) })"
        :disabled="Boolean(session.busy.value.live)"
        @click="session.debateNext()"
      />
    </div>
  </div>
</template>
