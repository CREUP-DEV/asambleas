<script setup lang="ts">
import type { VoteInput } from "~~/shared/types/api";
import type { ConsolidationConflict } from "~~/shared/types/content";
import { VOTE_METHODS } from "~~/shared/constants/domain";
import {
  isSessionFinalVoteReady,
  sessionCleanVote,
  sessionEmptyVote,
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
 * text goes back to its proponent.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

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
  vote.value = sessionEmptyVote(document.value?.majority ?? "simple");
  serverConflicts.value = [];
  serverUndecided.value = [];
  serverTie.value = false;
  serverTotalityReturn.value = null;
  confirming.value = false;
});

// Any change to the vote sends the Mesa back to the first step.
watch(
  vote,
  () => {
    confirming.value = false;
  },
  { deep: true },
);

const undecided = computed(() => session.undecided.value);
const conflicts = computed(() =>
  serverConflicts.value.length > 0
    ? serverConflicts.value
    : session.preview.value.conflicts,
);
const totalityReturn = computed(
  () => session.preview.value.totalityReturn?.id ?? serverTotalityReturn.value,
);
const outcome = computed(() =>
  sessionVoteOutcome(vote.value, session.settings.value),
);
const expected = computed(() =>
  sessionFinalVoteResult(vote.value, outcome.value),
);
const assent = computed(() => vote.value.method === "assent");
const blocked = computed(
  () =>
    !document.value ||
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
          v-if="undecided.length > 0 || serverUndecided.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-list-todo"
          :title="
            t(
              'session.finalVote.undecided',
              { count: Math.max(undecided.length, serverUndecided.length) },
              Math.max(undecided.length, serverUndecided.length),
            )
          "
          :description="
            (serverUndecided.length > 0
              ? serverUndecided
              : undecided.map((a) => a.id)
            )
              .map(session.label)
              .join(', ')
          "
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
