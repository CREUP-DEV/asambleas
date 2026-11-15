<script setup lang="ts">
import type { VoteInput } from "~~/shared/types/api";
import { ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import type { VoteMethod } from "~~/shared/constants/domain";
import { VOTE_QUESTION_MAX_LENGTH } from "~~/shared/utils/schemas/vote";
import {
  isSessionFinalVoteReady,
  sessionEmptyVote,
  sessionFinalVoteResult,
  sessionItemVotePlan,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { useVoteBaseText } from "~/composables/session/useVoteBaseText";

/**
 * Vote on an agenda item itself (a ratification, an election), for an item
 * none of whose documents is voted. The Mesa writes what is voted («Qué se
 * vota», the item's numbered title to start with when the public reads that
 * title), which the room sees with the result, and picks the method:
 * assent, show of hands, registered or secret, and the voting portal only
 * in an AGET. The majority is simple
 * unless the Mesa picks another; an assent nobody objected to when the Mesa
 * asked for unanimity can be recorded as unanimous.
 *
 * Like the final vote, recording takes two steps: the Mesa checks the
 * result before confirming it, so Enter never records. It records on the
 * item it opened for (the console closes it when the debate moves to
 * another item) and asks the server to put the result on screen.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.itemVoteDialog.open,
  set: (value: boolean) => {
    session.itemVoteDialog.open = value;
  },
});

/** The item the dialog opened for, captured then. */
const itemId = ref<string | null>(null);
/** That item as the Mesa reads it in its agenda (number and title). */
const row = computed(() =>
  itemId.value
    ? (session.agendaRows.value.find(
        (other) => other.item.id === itemId.value,
      ) ?? null)
    : null,
);
const itemLabel = computed(() =>
  row.value
    ? numberedAgendaTitle(
        row.value.number,
        row.value.item.title,
        t("agenda.unlisted.inText"),
      )
    : "",
);
/**
 * Whether it can still be recorded: a document of the item may have turned
 * voted while the dialog was open (then the server refuses it too, and the
 * dialog says so), or the assembly may have closed.
 */
const plan = computed(() =>
  row.value
    ? sessionItemVotePlan(
        row.value,
        session.itemVotes.value,
        session.assembly.value?.status,
      )
    : null,
);
const takesVote = computed(() => plan.value?.takesVote ?? false);
const canRecord = computed(() => plan.value?.canRecord ?? false);

/** Every counted method and assent; the voting portal only in an AGET. */
const methods = computed<VoteMethod[]>(() => [
  "assent",
  "show_of_hands",
  "roll_call",
  "secret",
  ...(session.assembly.value?.type === ASSEMBLY_TYPES.AGET
    ? (["portal"] as const)
    : []),
]);

const question = ref("");
const vote = ref<VoteInput>(sessionEmptyVote("simple"));
const serverTie = ref(false);
/** Second step: the result is shown for a last check before recording. */
const confirming = ref(false);
/**
 * Whether the Mesa left the question or tried to review the vote: only then
 * does an empty question show its error, so the field is never announced
 * as invalid before anyone typed. The empty question blocks recording
 * either way.
 */
const questionTouched = ref(false);
const summary = useTemplateRef<HTMLElement>("summary");
const questionId = useId();

watch(open, (isOpen) => {
  if (!isOpen) return;
  // Filled once, when it opens: an agenda refresh never overwrites what
  // the Mesa is typing.
  itemId.value = session.itemVoteDialog.agendaItemId;
  // The question goes to the room with the vote, so it starts with the
  // item's title only when someone who sees only what is public reads that
  // title (`publicTitleHidden`, worked out for that viewer whoever asks):
  // what the Mesa account reads itself never decides it. An item the public
  // does not get, or gets without its title (a withheld title, or one
  // carrying a document that is not public), starts empty; so does one
  // whose flag is missing.
  const item = row.value?.item;
  question.value =
    item &&
    !item.unlisted &&
    !item.titleHidden &&
    item.publicTitleHidden === false
      ? itemLabel.value.slice(0, VOTE_QUESTION_MAX_LENGTH)
      : "";
  // "Present" opens empty: the latest headcount fills it (VoteFields).
  vote.value = sessionEmptyVote("simple");
  serverTie.value = false;
  confirming.value = false;
  questionTouched.value = false;
});

// Any change sends the Mesa back to the first step, and so does a new
// headcount: with "present" empty it changes the base of the result.
watch(
  [vote, question, () => session.voteHeadcount.value?.id],
  () => {
    confirming.value = false;
  },
  { deep: true },
);

const assent = computed(() => vote.value.method === "assent");
/** An assent nobody objected to when unanimity was asked. */
const unanimous = computed({
  get: () => vote.value.unanimous === true,
  set: (value: boolean) => {
    vote.value = { ...vote.value, unanimous: value };
  },
});

// An empty "present" counts on the latest headcount, as on the server.
const outcome = computed(() =>
  sessionVoteOutcome(
    vote.value,
    session.settings.value,
    session.voteHeadcount.value,
  ),
);
const expected = computed(() =>
  sessionFinalVoteResult(vote.value, outcome.value),
);
const baseText = useVoteBaseText(
  vote,
  () => session.settings.value,
  () => session.voteHeadcount.value,
);
const questionMissing = computed(() => question.value.trim().length === 0);
const blocked = computed(
  () =>
    !row.value ||
    !canRecord.value ||
    questionMissing.value ||
    !isSessionFinalVoteReady(vote.value, outcome.value),
);

/** The method and the counts (or assent, or unanimity) in one line. */
const methodText = computed(() => {
  if (assent.value) {
    return unanimous.value
      ? t("session.itemVote.unanimous")
      : t("session.enums.approvalMethod.assent");
  }
  return `${t(`session.enums.voteMethod.${vote.value.method}`)} · ${t(
    "session.card.voteCounts",
    {
      inFavor: vote.value.inFavor ?? 0,
      against: vote.value.against ?? 0,
      abstentions: vote.value.abstentions ?? 0,
    },
  )}`;
});

/**
 * Submitting the form (button or Enter in a count) only opens the check
 * step. Recording needs the separate confirm button, so pressing Enter twice
 * never records a vote.
 */
function review(): void {
  questionTouched.value = true;
  if (blocked.value) return;
  confirming.value = true;
  void nextTick(() => summary.value?.focus());
}

function cancelOrBack(close: () => void): void {
  if (confirming.value) confirming.value = false;
  else close();
}

async function record(): Promise<void> {
  const target = itemId.value;
  if (blocked.value || !confirming.value || !target) return;
  const result = await session.recordItemVote(target, {
    question: question.value,
    vote: vote.value,
  });
  if (result.ok) {
    open.value = false;
    return;
  }
  confirming.value = false;
  serverTie.value = result.tie;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('session.itemVote.title')"
    :description="itemLabel"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form
        v-if="row"
        id="session-item-vote-form"
        class="space-y-4"
        @submit.prevent="review"
      >
        <UAlert
          v-if="!takesVote"
          color="warning"
          variant="subtle"
          icon="i-lucide-file-check-2"
          :title="t('session.errors.itemHasVotedDocuments')"
        />
        <UAlert
          v-if="serverTie"
          color="warning"
          variant="subtle"
          icon="i-lucide-scale"
          :title="t('session.vote.tieTitle')"
          :description="t('session.vote.tieRepeat')"
        />

        <UFormField
          :label="t('session.itemVote.question')"
          :help="t('session.itemVote.questionHelp')"
          :error="
            questionTouched && questionMissing
              ? t('session.itemVote.questionRequired')
              : false
          "
          :name="questionId"
          required
        >
          <UTextarea
            v-model="question"
            :rows="2"
            autoresize
            :maxlength="VOTE_QUESTION_MAX_LENGTH"
            class="w-full"
            @blur="questionTouched = true"
          />
        </UFormField>

        <SessionVoteFields
          v-model="vote"
          :settings="session.settings.value"
          :headcount="session.voteHeadcount.value"
          :methods="methods"
          :assent-text="t('session.itemVote.assentText')"
        />

        <UCheckbox
          v-if="assent"
          v-model="unanimous"
          :label="t('session.itemVote.unanimous')"
          :description="t('session.itemVote.unanimousHint')"
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
          <p class="text-default mt-1 text-sm whitespace-pre-line">
            {{ question.trim() }}
          </p>
          <p
            class="text-default mt-1 flex flex-wrap items-center gap-2 text-sm"
          >
            <UBadge
              :color="expected === 'approved' ? 'success' : 'error'"
              variant="solid"
              :label="t(`session.vote.result.${expected}`)"
            />
            <span class="tabular-nums">{{ methodText }}</span>
          </p>
          <p v-if="!assent" class="text-muted mt-1 text-xs tabular-nums">
            {{ baseText }}
          </p>
          <p class="text-muted mt-2 text-xs">
            {{ t("session.itemVote.confirmDescription") }}
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
          :loading="Boolean(session.busy.value['item-vote'])"
          :disabled="blocked"
          @click="record"
        />
        <UButton
          v-else
          type="submit"
          form="session-item-vote-form"
          icon="i-lucide-gavel"
          :label="t('session.itemVote.submit')"
          :disabled="blocked"
        />
      </div>
    </template>
  </UModal>
</template>
