<script setup lang="ts">
import type { VoteInput } from "~~/shared/types/api";
import type { ConsolidationConflict } from "~~/shared/types/content";
import { VOTE_METHODS } from "~~/shared/constants/domain";
import {
  isSessionFinalVoteReady,
  sessionCleanVote,
  sessionEmptyVote,
  sessionFinalVoteBlockers,
  sessionFillPresent,
  sessionFinalVoteResult,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Final vote on the whole text. The document's majority is the default, and
 * texts nobody opposes (minutes, for instance) can be approved by assent,
 * without counts. Recording takes two steps: the Mesa checks the result
 * before confirming it. When approved, the server consolidates the approved
 * amendments; if they cannot be applied together it answers 409 and the
 * conflicts are listed. An approved totality return blocks the vote: the
 * text goes back to its proponent. Amendments still open block it too,
 * listed by who has to act: the Mesa (undecided), the assembly (late ones
 * it has not agreed to treat), the main authors (transactionals they have
 * not accepted) and the Secretaría (not validated yet).
 */
const session = useSessionConsoleContext();
const { t, locale } = useI18n();

const open = computed({
  get: () => session.finalVoteDialog.open,
  set: (value: boolean) => {
    session.finalVoteDialog.open = value;
  },
});
const document = computed(() => session.document.value);

/** Every method, assent included: a text nobody opposes needs no count. */
const FINAL_VOTE_METHODS = [...VOTE_METHODS];

const vote = ref<VoteInput>(sessionEmptyVote("simple"));
const serverConflicts = ref<ConsolidationConflict[]>([]);
const serverUndecided = ref<string[]>([]);
const serverTie = ref(false);
const serverTotalityReturn = ref<string | null>(null);
/** Second step: the result is shown for a last check before recording. */
const confirming = ref(false);
const summary = useTemplateRef<HTMLElement>("summary");

watch(open, (isOpen) => {
  if (!isOpen) return;
  // "Present" opens empty: the latest headcount fills it (VoteDialog).
  vote.value = sessionEmptyVote(document.value?.majority ?? "simple");
  serverConflicts.value = [];
  serverUndecided.value = [];
  serverTie.value = false;
  serverTotalityReturn.value = null;
  confirming.value = false;
});

// Any change to the vote sends the Mesa back to the first step, and so does
// a new headcount: with "present" empty it changes the base of the result.
watch(
  [vote, () => session.voteHeadcount.value?.id],
  () => {
    confirming.value = false;
  },
  { deep: true },
);

const undecided = computed(() => session.undecided.value);
/** Every amendment still open, split by who has to act (server ids too). */
const blockers = computed(() =>
  sessionFinalVoteBlockers(session.amendments.value, serverUndecided.value),
);
/**
 * What the Mesa cannot settle by deciding: transactionals that can no
 * longer go ahead (to withdraw), late amendments the assembly has not
 * agreed to treat, transactionals the main authors have not accepted and
 * amendments the Secretaría has not validated.
 */
const otherBlockers = computed(() =>
  [
    {
      key: "session.preview.superseded",
      icon: "i-lucide-git-pull-request-closed",
      ids: blockers.value.superseded,
    },
    {
      key: "session.preview.late",
      icon: "i-lucide-clock-alert",
      ids: blockers.value.late,
    },
    {
      key: "session.preview.awaitingAuthors",
      icon: "i-lucide-user-round-check",
      ids: blockers.value.awaitingAuthors,
    },
    {
      key: "session.preview.awaitingValidation",
      icon: "i-lucide-hourglass",
      ids: blockers.value.awaitingValidation,
    },
  ].filter((group) => group.ids.length > 0),
);
const conflicts = computed(() =>
  serverConflicts.value.length > 0
    ? serverConflicts.value
    : session.preview.value.conflicts,
);
const totalityReturn = computed(
  () => session.preview.value.totalityReturn?.id ?? serverTotalityReturn.value,
);
// An empty "present" counts on the latest headcount, as on the server.
const outcome = computed(() =>
  sessionVoteOutcome(
    vote.value,
    session.settings.value,
    session.voteHeadcount.value,
  ),
);
const now = useAppNow();
/**
 * The base the result is counted on, for the confirmation: "Base de
 * cálculo: 40 miembros presentes", with the count's day when the base is a
 * count taken another day (Europe/Madrid).
 */
const baseText = computed(() => {
  const counted = sessionFillPresent(
    vote.value,
    session.voteHeadcount.value,
    session.settings.value,
  );
  const onPresent =
    session.settings.value.denominator === "present" && counted.present != null;
  const text = t("session.vote.denominator", {
    count: outcome.value.denominator,
    base: onPresent
      ? t("session.vote.denominatorPresent")
      : t("session.vote.denominatorValid"),
  });
  const headcount = session.voteHeadcount.value;
  if (!onPresent || !headcount || counted.present !== headcount.present) {
    return text;
  }
  const taken = formatMoment(headcount.takenAt, {
    locale: locale.value,
    now: now.value,
  });
  return taken.today
    ? text
    : `${text} · ${t("session.vote.countMoment", { moment: taken.text })}`;
});
const expected = computed(() =>
  sessionFinalVoteResult(vote.value, outcome.value),
);
const assent = computed(() => vote.value.method === "assent");
const blocked = computed(
  () =>
    !document.value ||
    // The amendments of this document have not loaded: an empty list would
    // hide undecided amendments and a totality return.
    !session.amendmentsDto.value ||
    undecided.value.length > 0 ||
    Boolean(totalityReturn.value) ||
    !isSessionFinalVoteReady(vote.value, outcome.value),
);

function conflictText(conflict: ConsolidationConflict): string {
  const code = session.label(conflict.amendmentId);
  return conflict.conflictsWith.length > 0
    ? t("session.preview.conflictWith", {
        code,
        others: conflict.conflictsWith.map(session.label).join(", "),
      })
    : t("session.preview.conflictInvalid", { code });
}

/**
 * Submitting the form (button or Enter in a count) only opens the check
 * step. Recording needs the separate confirm button, so pressing Enter twice
 * never records a vote.
 */
function review(): void {
  if (blocked.value) return;
  confirming.value = true;
  void nextTick(() => summary.value?.focus());
}

function cancelOrBack(close: () => void): void {
  if (confirming.value) confirming.value = false;
  else close();
}

async function record(): Promise<void> {
  if (blocked.value || !confirming.value) return;
  const result = await session.finalVote({
    vote: sessionCleanVote(vote.value),
  });
  if (result.ok) {
    open.value = false;
    return;
  }
  confirming.value = false;
  serverConflicts.value = result.conflicts;
  serverUndecided.value = result.undecided;
  serverTie.value = result.tie;
  serverTotalityReturn.value = result.totalityReturn;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('session.finalVote.title')"
    :description="document?.title"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form
        v-if="document"
        id="session-final-vote-form"
        class="space-y-4"
        @submit.prevent="review"
      >
        <UAlert
          v-if="totalityReturn"
          color="error"
          variant="subtle"
          icon="i-lucide-undo-2"
          :title="
            t('session.preview.totalityReturnBlocked', {
              code: session.label(totalityReturn),
            })
          "
        />
        <UAlert
          v-if="blockers.undecided.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-list-todo"
          :title="
            t(
              'session.finalVote.undecided',
              { count: blockers.undecided.length },
              blockers.undecided.length,
            )
          "
          :description="blockers.undecided.map(session.label).join(', ')"
        />
        <UAlert
          v-for="group in otherBlockers"
          :key="group.key"
          color="warning"
          variant="subtle"
          :icon="group.icon"
          :title="t(group.key, { count: group.ids.length }, group.ids.length)"
          :description="group.ids.map(session.label).join(', ')"
        />
        <UAlert
          v-if="conflicts.length > 0"
          color="error"
          variant="subtle"
          icon="i-lucide-git-compare"
          :title="t('session.finalVote.conflictsTitle')"
        >
          <template #description>
            <ul class="mt-1 list-disc space-y-1 ps-4">
              <li v-for="conflict in conflicts" :key="conflict.amendmentId">
                {{ conflictText(conflict) }}
              </li>
            </ul>
            <p class="mt-2">{{ t("session.finalVote.conflictsHint") }}</p>
          </template>
        </UAlert>
        <UAlert
          v-if="serverTie"
          color="warning"
          variant="subtle"
          icon="i-lucide-scale"
          :title="t('session.vote.tieTitle')"
          :description="t('session.vote.tieRepeat')"
        />

        <SessionVoteFields
          v-model="vote"
          :settings="session.settings.value"
          :headcount="session.voteHeadcount.value"
          :methods="FINAL_VOTE_METHODS"
        />

        <div
          v-if="confirming"
          ref="summary"
          tabindex="-1"
          role="status"
          class="rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :class="
            expected === 'approved'
              ? 'border-success/50 bg-success/10'
              : 'border-error/50 bg-error/10'
          "
        >
          <p class="text-highlighted font-semibold">
            {{ t("session.finalVote.confirmTitle") }}
          </p>
          <p
            class="text-default mt-1 flex flex-wrap items-center gap-2 text-sm"
          >
            <UBadge
              :color="expected === 'approved' ? 'success' : 'error'"
              variant="solid"
              :label="t(`session.vote.result.${expected}`)"
            />
            <span class="tabular-nums">
              {{
                assent
                  ? t("session.enums.approvalMethod.assent")
                  : `${t(`session.enums.voteMethod.${vote.method}`)} · ${t(
                      "session.card.voteCounts",
                      {
                        inFavor: vote.inFavor ?? 0,
                        against: vote.against ?? 0,
                        abstentions: vote.abstentions ?? 0,
                      },
                    )}`
              }}
            </span>
          </p>
          <p v-if="!assent" class="text-muted mt-1 text-xs tabular-nums">
            {{ baseText }}
          </p>
          <p class="text-muted mt-2 text-xs">
            {{ t("session.finalVote.confirmDescription") }}
          </p>
        </div>
      </form>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="confirming ? t('common.back') : t('common.cancel')"
          @click="cancelOrBack(close)"
        />
        <UButton
          v-if="confirming"
          type="button"
          icon="i-lucide-gavel"
          :color="expected === 'approved' ? 'primary' : 'error'"
          :label="t('session.finalVote.confirm')"
          :loading="Boolean(session.busy.value['final-vote'])"
          :disabled="blocked"
          @click="record"
        />
        <UButton
          v-else
          type="submit"
          form="session-final-vote-form"
          icon="i-lucide-gavel"
          :label="t('session.finalVote.submit')"
          :disabled="blocked"
        />
      </div>
    </template>
  </UModal>
</template>
