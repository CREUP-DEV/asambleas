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
// "Present" opens empty: the latest headcount fills it, on screen and on
// the server, also one another Mesa device takes while the form is open.
watch(open, (isOpen) => {
  if (isOpen) vote.value = sessionEmptyVote(proposedMajority.value);
});

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
const saving = computed(() =>
  amendment.value ? Boolean(session.busy.value[amendment.value.id]) : false,
);

async function submit(): Promise<void> {
  if (!amendment.value || blocked.value) return;
  const result = await session.vote(
    amendment.value,
    sessionCleanVote(vote.value),
  );
  if (result) open.value = false;
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
      <form
        v-if="amendment"
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
          :disabled="blocked || !amendment"
        />
      </div>
    </template>
  </UModal>
</template>
