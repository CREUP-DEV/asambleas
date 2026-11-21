<script setup lang="ts">
import { voteTextKey } from "~~/shared/utils/votes";
import type { VoteInput } from "~~/shared/types/api";
import { ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import type { VoteMethod } from "~~/shared/constants/domain";
import { VOTE_QUESTION_MAX_LENGTH } from "~~/shared/utils/schemas/vote";
import {
  isSessionFinalVoteReady,
  sessionElectionCandidates,
  sessionEmptyVote,
  sessionFinalVoteResult,
  sessionItemVotePlan,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import type { LiveTallyAnnounce } from "~/composables/session/liveTally";
import { useVoteBaseText } from "~/composables/session/useVoteBaseText";
import {
  computeElectionOutcome,
  electionRunoffRule,
  type ElectionInput,
  type ElectionRecord,
} from "~~/shared/utils/election";

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
 * An election (user's decisions of 2026-11-21) records candidates and
 * their votes instead of in favour and against: the Mesa sets the posts
 * (the most that may be elected), the most each ballot may mark and the
 * rule (the absolute majority with a second round, or a simple majority),
 * by secret ballot to start with; «Mostrar el recuento en la proyección»
 * beside «Es una elección» puts its count on screen as it is entered. An item whose sub-items are candidacies
 * (or that holds them itself) opens as an election among them
 * (sessionElectionCandidates). When a second round is due, once the first
 * is recorded the dialog stays open with it prepared: the candidates who
 * go, the posts left and a simple majority.
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

/** An election instead of a vote in favour or against. */
const isElection = ref(false);
function emptyElection(): ElectionInput {
  return {
    candidates: ["", ""],
    posts: 1,
    maxChoices: 1,
    rule: "absolute_runoff",
    counts: [0, 0],
    ballots: 0,
  };
}
const election = ref<ElectionInput>(emptyElection());
/**
 * «Mostrar el recuento en la proyección», beside «Es una elección» (user's
 * decision of 2026-11-21): off until the Mesa turns it on, off again for a
 * second round.
 */
const electionProjected = ref(false);
/** The first round just recorded, when the dialog prepared the second. */
const runoffFrom = ref<ElectionRecord | null>(null);
/** An election is secret, by show of hands or, in an AGET, on the portal. */
const electionMethods = computed<VoteMethod[]>(() =>
  methods.value.filter(
    (method) => method !== "assent" && method !== "roll_call",
  ),
);
function setElectionMethod(method: VoteMethod): void {
  // Only what the method counts: blank and invalid, or abstentions.
  vote.value = {
    ...vote.value,
    method,
    inFavor: 0,
    against: 0,
    abstentions: 0,
    blank: 0,
    invalid: 0,
  };
}
watch(isElection, (on) => {
  if (on) {
    if (!electionMethods.value.includes(vote.value.method)) {
      setElectionMethod("secret");
    }
  } else {
    runoffFrom.value = null;
    electionProjected.value = false;
  }
});
const voteCount = (key: "blank" | "invalid" | "abstentions") =>
  computed({
    get: () => vote.value[key] ?? 0,
    set: (value: number) => {
      vote.value = { ...vote.value, [key]: value };
    },
  });
const electionBlank = voteCount("blank");
const electionInvalid = voteCount("invalid");
const electionAbstentions = voteCount("abstentions");
const electionOutcome = computed(() =>
  computeElectionOutcome(
    election.value,
    {
      blank: vote.value.blank ?? 0,
      invalid: vote.value.invalid ?? 0,
      present:
        vote.value.present ?? session.voteHeadcount.value?.present ?? null,
    },
    session.settings.value,
  ),
);
/** The election as it would be recorded, for the check step. */
const electionRecord = computed<ElectionRecord>(() => ({
  ...election.value,
  candidates: election.value.candidates.map((name) => name.trim()),
  elected: electionOutcome.value.elected,
  runoff: electionOutcome.value.runoff,
  tie: electionOutcome.value.tie,
}));
/** Why the election cannot be recorded yet, if anything. */
const electionProblem = computed<string | null>(() => {
  const current = election.value;
  if (current.candidates.some((name) => name.trim().length === 0)) {
    return t("session.election.problems.names");
  }
  const total = current.counts.reduce((sum, value) => sum + value, 0);
  if (total === 0 && (vote.value.blank ?? 0) === 0) {
    return t("session.election.problems.empty");
  }
  if (
    current.counts.some((value) => value > current.ballots) ||
    total > current.ballots * current.maxChoices
  ) {
    return t("session.election.problems.ballots");
  }
  if (electionOutcome.value.inconsistent) {
    return t("session.election.inconsistent");
  }
  return null;
});
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

/**
 * What a secret vote counted here announces on the projection: the item,
 * and the question only when the public reads the item's title (the
 * question may repeat it; the server drops it otherwise too).
 */
const announce = computed<LiveTallyAnnounce | null>(() => {
  if (!itemId.value) return null;
  const item = row.value?.item;
  const titlePublic =
    item !== undefined &&
    !item.unlisted &&
    !item.titleHidden &&
    item.publicTitleHidden === false;
  return {
    subject: { type: "agenda_item", id: itemId.value },
    question: titlePublic ? question.value : null,
  };
});

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
  isElection.value = false;
  election.value = emptyElection();
  electionProjected.value = false;
  // An election point opens as an election among its candidacies
  // (sessionElectionCandidates), which the Mesa can still edit.
  const candidates = itemId.value
    ? sessionElectionCandidates(itemId.value, session.agendaRows.value)
    : [];
  if (candidates.length > 0) {
    isElection.value = true;
    election.value = {
      ...emptyElection(),
      candidates,
      counts: candidates.map(() => 0),
    };
    setElectionMethod("secret");
  }
  runoffFrom.value = null;
  serverTie.value = false;
  confirming.value = false;
  questionTouched.value = false;
});

// Any change sends the Mesa back to the first step, and so does a new
// headcount: with "present" empty it changes the base of the result.
watch(
  [vote, question, isElection, election, () => session.voteHeadcount.value?.id],
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
/** A first round that sends someone to a second: not a rejection. */
const goesToRunoff = computed(
  () => isElection.value && (electionRecord.value.runoff?.length ?? 0) > 0,
);
const expected = computed(() =>
  isElection.value
    ? electionRecord.value.elected.length >=
      Math.min(election.value.posts, election.value.candidates.length)
      ? "approved"
      : "rejected"
    : sessionFinalVoteResult(vote.value, outcome.value),
);
const electionText = useElectionText();
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
    (isElection.value
      ? electionProblem.value !== null
      : !isSessionFinalVoteReady(vote.value, outcome.value)),
);

/** The method and the counts (or assent, or unanimity) in one line. */
const methodText = computed(() => {
  if (assent.value) {
    return unanimous.value
      ? t("session.itemVote.unanimous")
      : t("session.enums.approvalMethod.assent");
  }
  return `${t(`session.enums.voteMethod.${vote.value.method}`)} · ${t(
    voteTextKey("session.card.voteCounts", vote.value.method),
    {
      inFavor: vote.value.inFavor ?? 0,
      against: vote.value.against ?? 0,
      abstentions: vote.value.abstentions ?? 0,
      blank: vote.value.blank ?? 0,
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

/**
 * The second round, prepared in the same dialog: the candidates who go,
 * the posts left, by a simple majority, the same method and question.
 */
function prepareRunoff(first: ElectionRecord): void {
  const candidates = (first.runoff ?? []).map(
    (index) => first.candidates[index] ?? "",
  );
  const posts = Math.min(first.posts, first.candidates.length);
  const left = Math.max(
    1,
    Math.min(posts - first.elected.length, candidates.length),
  );
  election.value = {
    candidates,
    counts: candidates.map(() => 0),
    posts: left,
    // A ballot never marks more than in the first round, nor than the
    // posts left.
    maxChoices: Math.max(1, Math.min(first.maxChoices, left)),
    rule: electionRunoffRule(first.rule),
    ballots: 0,
  };
  electionProjected.value = false;
  setElectionMethod(vote.value.method);
  vote.value = { ...vote.value, note: null };
  runoffFrom.value = first;
  confirming.value = false;
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
    ...(isElection.value ? { election: election.value } : {}),
  });
  if (result.ok) {
    const first = result.vote.election;
    if (first?.runoff && first.runoff.length > 0) {
      prepareRunoff(first);
      return;
    }
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

        <!-- An election, and whether its count goes on screen. -->
        <div class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <USwitch
            v-model="isElection"
            :label="t('session.election.toggle')"
            :description="t('session.election.toggleHelp')"
          />
          <div
            v-if="isElection && session.inSession.value"
            class="min-w-0 space-y-1"
          >
            <USwitch
              v-model="electionProjected"
              :label="t('session.election.project')"
              :description="t('session.election.projectHelp')"
            />
            <p
              v-if="electionProjected && !session.inControl.value"
              class="text-muted text-xs"
            >
              {{ t("session.vote.reveal.notProjected") }}
            </p>
          </div>
        </div>

        <template v-if="isElection">
          <UAlert
            v-if="runoffFrom"
            color="info"
            variant="subtle"
            icon="i-lucide-repeat"
            :title="t('session.election.runoffReady.title')"
            :description="
              t('session.election.runoffReady.description', {
                first: electionText.outcome(runoffFrom),
                rule: t(
                  `session.election.rules.${electionRunoffRule(runoffFrom.rule)}`,
                ),
              })
            "
          />
          <URadioGroup
            :model-value="vote.method"
            :legend="t('session.vote.method')"
            :items="
              electionMethods.map((method) => ({
                value: method,
                label: t(`session.enums.voteMethod.${method}`),
              }))
            "
            orientation="horizontal"
            @update:model-value="
              (value) => setElectionMethod(value as VoteMethod)
            "
          />
          <!-- A new form for the second round: the first round's count
               leaves the screen until the Mesa shows the new one. -->
          <SessionElectionFields
            :key="runoffFrom ? 'runoff' : 'first'"
            v-model="election"
            v-model:blank="electionBlank"
            v-model:invalid="electionInvalid"
            v-model:abstentions="electionAbstentions"
            v-model:projected="electionProjected"
            :settings="session.settings.value"
            :headcount="session.voteHeadcount.value"
            :secret="vote.method === 'secret'"
            :method="vote.method"
            :announce="announce"
          />
          <p
            v-if="electionProblem && election.counts.some((value) => value > 0)"
            class="text-warning text-sm"
          >
            {{ electionProblem }}
          </p>
        </template>

        <SessionVoteFields
          v-else
          v-model="vote"
          :settings="session.settings.value"
          :headcount="session.voteHeadcount.value"
          :methods="methods"
          :assent-text="t('session.itemVote.assentText')"
          :announce="announce"
          unanimity
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
              : goesToRunoff
                ? 'border-warning/50 bg-warning/10'
                : 'border-error/50 bg-error/10'
          "
        >
          <p class="text-highlighted font-semibold">
            {{ t("session.finalVote.confirmTitle") }}
          </p>
          <p class="text-default mt-1 text-sm whitespace-pre-line">
            {{ question.trim() }}
          </p>
          <div v-if="isElection" class="mt-2 space-y-1">
            <p class="text-highlighted text-sm font-medium">
              {{ electionText.outcome(electionRecord) }}
              <span class="text-muted font-normal">
                · {{ t(`session.enums.voteMethod.${vote.method}`) }}
              </span>
            </p>
            <VoteElection :election="electionRecord" />
          </div>
          <p
            v-else
            class="text-default mt-1 flex flex-wrap items-center gap-2 text-sm"
          >
            <UBadge
              :color="expected === 'approved' ? 'success' : 'error'"
              variant="solid"
              :label="t(`session.vote.result.${expected}`)"
            />
            <span class="tabular-nums">{{ methodText }}</span>
          </p>
          <p
            v-if="!assent && !isElection"
            class="text-muted mt-1 text-xs tabular-nums"
          >
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
          :color="expected === 'approved' || goesToRunoff ? 'primary' : 'error'"
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
