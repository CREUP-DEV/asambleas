<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  isSessionClosureReversible,
  isSessionPublishable,
  isSessionReopenable,
  isSessionTransactable,
  sessionClosingSourceIds,
  sessionLapsingTransactionalIds,
  sessionMissingAcceptances,
  sessionReplacedIds,
  sessionReplacingIds,
  sessionSupersededSourceIds,
  sessionTransactionalRejectors,
} from "~/composables/session/sessionModel";
import { useFinalVoteReasonText } from "~/composables/session/useFinalVoteReasonText";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { useSessionPosition } from "~/composables/session/useSessionPosition";

/**
 * The amendment under debate, in large type: who presents it, where it
 * stands as a sentence that says what comes next, its change over the base
 * text, the answer of the document's main presenter (or of the Mesa on its
 * behalf, said so) and, for a transactional, the answer of the main author
 * of each amendment it replaces and which ones it already replaced. Below,
 * the actions that fit where it stands, the one that matters most first:
 *
 * - open: approve by assent or vote (assent leads when the main presenter
 *   accepts it), plus transactional, withdrawal and lapse; the rest in
 *   "Más". On a phone only assent, vote, "Más" and "Siguiente" stay in the
 *   row: transactional, withdrawal and lapse move to the top of "Más". A
 *   pending transactional over it, which deciding it would withdraw, is
 *   named under the status, with who it waits for;
 * - a transactional waiting for its main authors: recording their answers
 *   is the next step, so their list comes right under the status and no
 *   decision is offered; its withdrawal stays in "Más";
 * - a transactional another one got ahead of: only its withdrawal; one
 *   the server closed on its own says which amendment settled first, and
 *   one that lapsed because another replaced its amendments first names
 *   that one;
 * - incorporated (the main presenter accepted it in a document that
 *   incorporates accepted amendments): already in the text, no vote; until
 *   the final vote the presenter's answer can still be changed from "Más",
 *   which reopens it;
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
const answer = useSessionPosition(session);
const { t } = useI18n();
/** Shortcut letters show only while this browser keeps them on. */
const { enabled: shortcutsEnabled } = useSingleKeyShortcuts();
function kbdsOf(key: string): string[] | undefined {
  return shortcutsEnabled.value ? [key] : undefined;
}

const id = computed(() => props.amendment.id);
const code = computed(() => session.label(id.value));
const stage = computed(() => session.stageOf(props.amendment));
const busy = computed(() => Boolean(session.busy.value[id.value]));
const missing = computed(() => sessionMissingAcceptances(props.amendment));
/** The Mesa can approve, vote, transact, withdraw or lapse it now. */
const open = computed(() => stage.value === "open");
/** A transactional whose main authors have not all answered yet. */
const awaitingAnswers = computed(() => stage.value === "acceptances");
const transactable = computed(() => isSessionTransactable(props.amendment));
const decided = computed(() => props.amendment.status !== "submitted");
/** After the final vote nothing about its amendments changes. */
const voted = computed(() => Boolean(session.document.value?.finalVote));
const next = computed(() => session.nextAmendment.value);
/** Wide enough for every decision in the row; on a phone some go to "Más". */
const wide = useMediaQuery("(min-width: 640px)");

/**
 * Assent leads when the document's main presenter accepts the amendment:
 * nobody is expected to oppose it, and assent is a way of voting.
 */
const assentFirst = computed(
  () => props.amendment.position?.position === "accept",
);

const codes = (ids: string[]) => ids.map(session.label).join(", ");
/** Sources this transactional already replaced (they are transacted). */
const replaced = computed(() =>
  sessionReplacedIds(props.amendment, session.byId.value),
);

const statusText = computed(() => {
  const value = stage.value;
  switch (value) {
    case "acceptances":
      return t(
        "session.now.stage.acceptances",
        { count: missing.value, codes: codes(props.amendment.sourceIds) },
        missing.value,
      );
    case "open":
      return assentFirst.value
        ? t("session.now.stage.openAccepted")
        : t("session.now.stage.open");
    case "transacted":
      return t("session.now.stage.transacted", {
        codes: codes(sessionReplacingIds(props.amendment, session.byId.value)),
      });
    case "turned_down":
      return t("session.now.stage.turned_down", {
        members: sessionTransactionalRejectors(props.amendment)
          .map((member) => member.acronym)
          .join(", "),
      });
    case "superseded":
      return t("session.now.stage.superseded", {
        codes: codes(
          sessionSupersededSourceIds(props.amendment, session.byId.value),
        ),
      });
    case "closed":
      return t(
        isSessionClosureReversible(
          props.amendment,
          session.byId.value,
          voted.value,
        )
          ? "session.now.stage.closedReversible"
          : "session.now.stage.closed",
        {
          codes: codes(
            sessionClosingSourceIds(props.amendment, session.byId.value),
          ),
        },
      );
    case "lapsed": {
      // Left behind because another transactional replaced its sources
      // first: name that one.
      const ahead = sessionLapsingTransactionalIds(
        props.amendment,
        session.byId.value,
      );
      return ahead.length > 0
        ? t("session.now.stage.lapsedBy", { codes: codes(ahead) })
        : t("session.now.stage.lapsed");
    }
    default:
      return t(`session.now.stage.${value}`);
  }
});

const outcomeDetail = computed(() => {
  const parts: string[] = [];
  // Incorporated: the sentence above already says how it got in.
  if (props.amendment.approvalMethod && stage.value !== "incorporated") {
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
/**
 * A pending transactional over it, which deciding it would withdraw:
 * "Hay una transaccional en curso sobre ella: T9, espera a UPV." The
 * one-click decisions ask before (confirmSettling).
 */
const transactionalsLine = computed(() =>
  session.transactionalsOver.line(props.amendment),
);

/**
 * Turned down or closed by the server: the status sentence already says
 * who or why, and what follows.
 */
const outcomeNote = computed(() =>
  stage.value === "turned_down" || stage.value === "closed"
    ? null
    : props.amendment.outcomeNote,
);

const STAGE_TONE: Record<string, string> = {
  open: "border-info/40 bg-info/5",
  acceptances: "border-warning/50 bg-warning/5",
  superseded: "border-warning/50 bg-warning/5",
  late: "border-warning/50 bg-warning/5",
  incorporated: "border-success/50 bg-success/10",
  approved: "border-success/50 bg-success/10",
  rejected: "border-error/50 bg-error/10",
};

const showJustification = ref(false);
watch(id, () => {
  showJustification.value = false;
});

// Actions ------------------------------------------------------------------------

const finalVoteReady = computed(
  () =>
    !next.value &&
    session.finalVoteReasons.value.length === 0 &&
    !voted.value &&
    Boolean(session.document.value?.can.moderate),
);

/** Decided, with nothing to debate next and no final vote to open yet. */
const stuck = computed(
  () => decided.value && !next.value && !finalVoteReady.value,
);
const reasonText = useFinalVoteReasonText(session.label);
/** Why the final vote waits, when nothing else can be debated now. */
const waitingReasons = computed(() =>
  stuck.value && !voted.value
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

/**
 * The main presenter's answer, recorded in the room on its behalf. Only
 * published amendments are answered, and not after the final vote: the
 * text is fixed and the server refuses it.
 */
const positionItem = computed(() => answer.menuItem(props.amendment));
/** Who gave the answer shown: the main presenter, or the Mesa for it. */
const positionLabel = computed(() => answer.label(props.amendment));
/** Still private: nobody can answer it yet (the "Más" entry is disabled). */
const positionWait = computed(() => answer.waitHint(props.amendment));

const relateItem = computed<DropdownMenuItem>(() => ({
  label: t("session.actions.relate"),
  icon: "i-lucide-link",
  onSelect: () => session.openRelation(props.amendment),
}));

const moreItems = computed<DropdownMenuItem[][]>(() => {
  const amendment = props.amendment;
  const groups: DropdownMenuItem[][] = [];
  const position = positionItem.value;
  if (open.value && !wide.value) {
    // On a phone the row keeps assent and vote; the other decisions lead
    // "Más".
    groups.push([
      ...(transactable.value
        ? [
            {
              label: t("session.actions.transact"),
              icon: "i-lucide-git-merge",
              onSelect: () => session.openComposer([amendment.id]),
            },
          ]
        : []),
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
  if (open.value) {
    // In a document that incorporates accepted amendments, accepting is
    // how one gets in: the answer is recorded, not an outcome.
    const decide: DropdownMenuItem[] = [
      {
        label: t("session.actions.formal"),
        icon: "i-lucide-spell-check",
        onSelect: () => void session.approve(amendment, "formal"),
      },
    ];
    if (position) decide.push(position);
    groups.push(decide);
    groups.push([
      {
        label: t("session.actions.inadmit"),
        icon: "i-lucide-octagon-x",
        color: "error",
        onSelect: () => session.openAdmission([amendment.id], "inadmissible"),
      },
      relateItem.value,
    ]);
  } else if (awaitingAnswers.value) {
    // Nothing is decided before every main author answers; the Mesa may
    // still withdraw it.
    groups.push([
      {
        label: t("session.actions.withdraw"),
        icon: "i-lucide-undo-2",
        onSelect: () => void session.withdraw(amendment),
      },
      relateItem.value,
    ]);
  }
  if (stage.value === "incorporated" && position) {
    // Changing the main presenter's answer is what takes it out again.
    groups.push([position]);
  } else if (
    decided.value &&
    !voted.value &&
    // Not one a main author turned down (closed, not an outcome to undo),
    // nor one another transactional got ahead of.
    isSessionReopenable(amendment, session.byId.value)
  ) {
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
      <h3 class="text-highlighted text-3xl font-bold tabular-nums sm:text-4xl">
        {{ t("session.card.label", { code }) }}
      </h3>
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
      <p v-if="outcomeNote" class="text-muted text-sm italic">
        {{ outcomeNote }}
      </p>
      <p
        v-if="transactionalsLine"
        class="text-default mt-1 flex items-start gap-1.5 text-sm"
      >
        <UIcon
          name="i-lucide-git-merge"
          class="text-warning mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        {{ transactionalsLine }}
      </p>
    </div>

    <!-- Waiting for its main authors: recording their answers comes next. -->
    <SessionAcceptanceList
      v-if="amendment.kind === 'transactional' && awaitingAnswers"
      :amendment="amendment"
    />

    <p
      v-if="amendment.position && !decided"
      class="text-default flex flex-wrap items-center gap-1.5 text-sm"
    >
      <span class="text-muted">{{ positionLabel }}</span>
      <CommonStatusBadge
        kind="position"
        :value="amendment.position.position"
        size="sm"
      />
      <span v-if="amendment.position.comment" class="text-muted min-w-0 italic">
        {{ amendment.position.comment }}
      </span>
    </p>
    <p v-if="positionWait" class="text-muted text-sm">{{ positionWait }}</p>

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

    <p
      v-if="amendment.kind === 'transactional' && replaced.length > 0"
      class="text-default flex items-start gap-1.5 text-sm"
    >
      <UIcon
        name="i-lucide-git-merge"
        class="text-secondary mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      {{ t("session.now.replaces", { codes: codes(replaced) }) }}
    </p>

    <!-- Who accepted it once it replaced its sources, or the answers of
         one another transactional got ahead of. -->
    <SessionAcceptanceList
      v-if="amendment.kind === 'transactional' && !decided && !awaitingAnswers"
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
      <template v-if="open">
        <UTooltip :text="t('session.now.assentHint')" :kbds="kbdsOf('a')">
          <UButton
            size="lg"
            color="success"
            :variant="assentFirst ? 'solid' : 'outline'"
            icon="i-lucide-check"
            :label="t('session.now.assent')"
            :loading="busy"
            :disabled="busy"
            @click="session.approve(amendment, 'assent')"
          />
        </UTooltip>
        <UTooltip :text="t('session.actions.voteHint')" :kbds="kbdsOf('v')">
          <UButton
            size="lg"
            color="primary"
            :variant="assentFirst ? 'outline' : 'solid'"
            icon="i-lucide-gavel"
            :label="t('session.actions.vote')"
            :disabled="busy"
            @click="session.openVote(amendment)"
          />
        </UTooltip>
        <template v-if="wide">
          <UButton
            v-if="transactable"
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

      <!-- Another transactional got ahead of it: only withdrawing settles it. -->
      <UButton
        v-else-if="stage === 'superseded'"
        size="lg"
        color="warning"
        icon="i-lucide-undo-2"
        :label="t('session.actions.withdraw')"
        :loading="busy"
        :disabled="busy"
        @click="session.withdrawSubmission(amendment)"
      />

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
