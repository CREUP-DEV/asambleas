<script setup lang="ts">
import { amendmentVoteMajority } from "~~/shared/constants/domain";
import type { VoteInput } from "~~/shared/types/api";
import {
  isSessionVoteReady,
  sessionCleanVote,
  sessionEmptyVote,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import type { LiveTallyAnnounce } from "~/composables/session/liveTally";

/**
 * Records the vote on one amendment. It proposes the majority of the
 * document's kind (amendmentVoteMajority: absolute in a reform of the
 * Estatutos or a regulation, simple otherwise); the Mesa may pick another.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.voteDialog.open,
  set: (value: boolean) => {
    session.voteDialog.open = value;
  },
});
const amendment = computed(() =>
  session.voteDialog.amendmentId
    ? (session.byId.value.get(session.voteDialog.amendmentId) ?? null)
    : null,
);

const proposedMajority = computed(() =>
  session.document.value
    ? amendmentVoteMajority(session.document.value.kind)
    : "simple",
);
const vote = ref<VoteInput>(sessionEmptyVote(proposedMajority.value));
/** This form is recording the vote: the amendment it decides is its own. */
const recording = ref(false);
// "Present" opens empty: the latest headcount fills it, on screen and on
// the server, also one another Mesa device takes while the form is open.
watch(open, (isOpen) => {
  if (isOpen) {
    vote.value = sessionEmptyVote(proposedMajority.value);
    recording.value = false;
  }
});
/**
 * Decided meanwhile from elsewhere (another console, the control sheet):
 * the form goes, which ends its count on the projection
 * (SessionVoteFields), and only the amendment's status is left.
 */
const decided = computed(
  () =>
    !recording.value &&
    amendment.value !== null &&
    amendment.value.status !== "submitted",
);
/** Its code and status, as the queue names them. */
const decidedLine = computed(() =>
  amendment.value
    ? `${session.label(amendment.value.id)} · ${t(`common.status.amendment.${amendment.value.status}`)}`
    : "",
);

// An empty "present" counts on the latest headcount, as on the server.
const outcome = computed(() =>
  sessionVoteOutcome(
    vote.value,
    session.settings.value,
    session.voteHeadcount.value,
  ),
);
/** A pending transactional over it, which the vote would withdraw. */
const transactionalsLine = computed(() =>
  amendment.value ? session.transactionalsOver.line(amendment.value) : null,
);
const blocked = computed(() => !isSessionVoteReady(vote.value, outcome.value));
/** What a secret vote counted here announces on the projection. */
const announce = computed<LiveTallyAnnounce | null>(() =>
  amendment.value
    ? { subject: { type: "amendment", id: amendment.value.id } }
    : null,
);
const saving = computed(() =>
  amendment.value ? Boolean(session.busy.value[amendment.value.id]) : false,
);

async function submit(): Promise<void> {
  if (!amendment.value || blocked.value || decided.value) return;
  recording.value = true;
  let recorded = false;
  try {
    recorded = Boolean(
      await session.vote(amendment.value, sessionCleanVote(vote.value)),
    );
  } finally {
    if (recorded) open.value = false;
    else recording.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      t('session.vote.title', {
        code: amendment ? session.label(amendment.id) : '',
      })
    "
    :description="t('session.vote.description')"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <UAlert
        v-if="amendment && decided"
        color="neutral"
        variant="subtle"
        icon="i-lucide-gavel"
        role="status"
        :title="decidedLine"
      />
      <form
        v-else-if="amendment"
        id="session-vote-form"
        class="space-y-4"
        @submit.prevent="submit"
      >
        <p
          v-if="transactionalsLine"
          class="text-default flex items-start gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-git-merge"
            class="text-warning mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {{ transactionalsLine }}
        </p>
        <SessionVoteFields
          v-model="vote"
          :settings="session.settings.value"
          :headcount="session.voteHeadcount.value"
          :announce="announce"
        />
      </form>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="close"
        />
        <UButton
          type="submit"
          form="session-vote-form"
          icon="i-lucide-gavel"
          :label="t('session.vote.submit')"
          :loading="saving"
          :disabled="blocked || !amendment || decided"
        />
      </div>
    </template>
  </UModal>
</template>
